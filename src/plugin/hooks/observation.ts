import * as fs from "fs";
import * as path from "path";
import type { PluginHookAgentContext, PluginHookAgentEndEvent, PluginHookBeforeCompactionEvent } from "../openclaw-types.js";
import type { ClawVaultPluginConfig } from "../config.js";
import { isFeatureEnabled, isOptInEnabled, resolveAgentId } from "../config.js";
import { resolveVaultPathForAgent, runObserverCron, shouldObserveActiveSessions } from "../clawvault-cli.js";
import { runFactExtractionForEvent } from "../fact-extractor.js";
import type { ClawVaultPluginRuntimeState } from "../runtime-state.js";

export interface ObservationHookDependencies {
  pluginConfig: ClawVaultPluginConfig;
  runtimeState?: ClawVaultPluginRuntimeState;
  logger?: {
    info: (message: string) => void;
    warn: (message: string) => void;
  };
}

function resolvePolicyText(configuredPath: string | undefined, workspaceDir: string | undefined, fallbackRel: string, fallbackText: string): string {
  const candidates: string[] = [];
  if (typeof configuredPath === "string" && configuredPath.trim()) {
    const trimmed = configuredPath.trim();
    candidates.push(path.isAbsolute(trimmed) ? trimmed : path.resolve(workspaceDir ?? process.cwd(), trimmed));
  }
  if (workspaceDir) {
    candidates.push(path.join(workspaceDir, fallbackRel));
  }
  for (const candidate of candidates) {
    try {
      const text = fs.readFileSync(candidate, "utf-8").trim();
      if (text) return text;
    } catch {
      // ignore
    }
  }
  return fallbackText;
}

function toText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => toText(item)).filter(Boolean).join(" ");
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return toText(record.content ?? record.text ?? "");
  }
  return "";
}

function isMeaningfulText(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  if (normalized.length < 24) return false;
  if (/^(ok|okay|thanks|thank you|done|yes|no|cool|great|got it)[.!]*$/i.test(normalized)) return false;
  return true;
}

function getLatestMeaningfulTurn(messages: unknown[]): { user: string; assistant: string } {
  const parsed = messages
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const record = entry as Record<string, unknown>;
      const role = typeof record.role === "string" ? record.role.toLowerCase() : "";
      const text = toText(record.content ?? record.text).replace(/\s+/g, " ").trim();
      if (!role || !text) return null;
      return { role, text };
    })
    .filter((entry): entry is { role: string; text: string } => Boolean(entry));

  let assistant = "";
  let user = "";
  for (let i = parsed.length - 1; i >= 0; i -= 1) {
    const entry = parsed[i];
    if (!assistant && entry.role === "assistant" && isMeaningfulText(entry.text)) {
      assistant = entry.text;
      continue;
    }
    if (!user && entry.role === "user" && isMeaningfulText(entry.text)) {
      user = entry.text;
    }
    if (user && assistant) break;
  }

  if (!assistant || !user) {
    for (let i = parsed.length - 1; i >= 0; i -= 1) {
      const entry = parsed[i];
      if (!assistant && entry.role === "assistant") assistant = entry.text;
      else if (!user && entry.role === "user") user = entry.text;
      if (user && assistant) break;
    }
  }

  return { user, assistant };
}

function shaLike(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
  }
  return String(hash);
}

type WritebackRoute = "boot" | "durable" | "source" | "discard";
type DurableCategory = "facts" | "feelings" | "decisions" | "lessons" | "commitments" | "preferences" | "people" | "projects" | "meetings" | "systems";
type MemoryType = "fact" | "feeling" | "decision" | "lesson" | "commitment" | "preference" | "relationship" | "project";

function classifyWriteback(userText: string, assistantText: string): WritebackRoute {
  const combined = `${userText}\n${assistantText}`.toLowerCase();
  if (!combined.trim()) return "discard";
  if (/\b(name:|timezone:|what to call|voice:|identity|role:)\b/.test(combined)) {
    return "boot";
  }
  if (/\b(decided|decision|agreed|will treat|resolved|preference|policy|meeting|action item|current state|remember|use this|treat .* as|took care of)\b/.test(combined)) {
    return "durable";
  }
  if (combined.length > 900) {
    return "source";
  }
  return "discard";
}

function inferDurableCategory(userText: string, assistantText: string): DurableCategory {
  const combined = `${userText}\n${assistantText}`.toLowerCase();
  if (/\bmeeting\b|\baction item\b|\binvitation\b/.test(combined)) return "meetings";
  if (/\bplugin\b|\bmemory law\b|\bagents\.md\b|\brecall\b|\bwriteback\b|\bopenclaw\b|\bclawvault\b|\bsystem\b/.test(combined)) return "systems";
  if (/\bdecid\w*\b|\bagreed\b|\bresolved\b|\bpolicy\b/.test(combined)) return "decisions";
  if (/\bprefer\w*\b|\bwhat to call\b|\bvoice\b|\bexpected /i.test(`${userText}\n${assistantText}`)) return "preferences";
  if (/\bproject\b|\bstate of\b|\bcurrent state\b|\bongoing\b/.test(combined)) return "projects";
  if (/\bshane\b|\btim\b|\bbrian\b|\bperson\b|\bpeople\b/.test(combined)) return "people";
  if (/\bcommit\w*\b|\bwill\b|\bneed to\b|\btodo\b|\btask\b/.test(combined)) return "commitments";
  if (/\blearned\b|\blesson\b|\bmistake\b/.test(combined)) return "lessons";
  if (/\bfeel\b|\bemotion\b|\bmood\b/.test(combined)) return "feelings";
  return "facts";
}

function mapCategoryToMemoryType(category: DurableCategory): MemoryType {
  switch (category) {
    case "feelings": return "feeling";
    case "decisions":
    case "meetings":
    case "systems": return "decision";
    case "lessons": return "lesson";
    case "commitments": return "commitment";
    case "preferences": return "preference";
    case "people": return "relationship";
    case "projects": return "project";
    case "facts":
    default: return "fact";
  }
}

function inferSourceType(category: DurableCategory): "conversation" | "meeting" | "email" | "document" | "system" {
  if (category === "meetings") return "meeting";
  if (category === "systems") return "system";
  return "conversation";
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\s-]/g, "").trim().replace(/\s+/g, "-").replace(/-+/g, "-").slice(0, 80) || "memory";
}

function buildDurableTitle(category: DurableCategory, userText: string, assistantText: string): string {
  const seed = userText || assistantText || category;
  return slugify(seed.split(/[.!?\n]/)[0] || category);
}

function yamlEscape(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function buildDurableFrontmatter(input: {
  title: string;
  category: DurableCategory;
  sessionKey?: string;
  origin?: string;
}): string {
  const lines = [
    "---",
    `title: ${yamlEscape(input.title)}`,
    `memory_type: ${mapCategoryToMemoryType(input.category)}`,
    `created: ${new Date().toISOString()}`,
    `source_type: ${inferSourceType(input.category)}`
  ];
  if (input.sessionKey) lines.push(`session_key: ${yamlEscape(input.sessionKey)}`);
  if (input.origin) lines.push(`origin: ${yamlEscape(input.origin)}`);
  lines.push("---", "");
  return lines.join("\n");
}

function appendMarkdownNote(filePath: string, title: string, body: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, `# ${title}\n\n${body.trim()}\n`, "utf-8");
    return;
  }
  fs.appendFileSync(filePath, `\n\n## ${new Date().toISOString()}\n\n${body.trim()}\n`, "utf-8");
}

function writeDurableNote(filePath: string, title: string, category: DurableCategory, body: string, sessionKey?: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const frontmatter = buildDurableFrontmatter({
    title,
    category,
    sessionKey,
    origin: "agent_writeback"
  });
  const content = `${frontmatter}# ${title}\n\n${body.trim()}\n`;
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, content, "utf-8");
    return;
  }
  fs.writeFileSync(filePath, content, "utf-8");
}

function detectBootSection(text: string): string {
  const normalized = text.toLowerCase();
  if (/\b(lucy|i am|my role|my voice|assistant)\b/.test(normalized)) return "Who I Am";
  if (/\b(shane|his role|he is|timezone|family|email account)\b/.test(normalized)) return "Who Shane Is";
  if (/\b(email|gmail|yahoo|inbox)\b/.test(normalized)) return "Shane's Email Accounts";
  if (/\b(voice|elevenlabs|jessica|tts)\b/.test(normalized)) return "My Voice";
  if (/\bonedrive|drive id|graph api\b/.test(normalized)) return "OneDrive";
  if (/\blamp|device|home assistant|switch\b/.test(normalized)) return "Home Devices";
  if (/\bollama|local model|pip\b/.test(normalized)) return "Local Model Delegation";
  return "Boot Notes";
}

function upsertMemorySection(memoryPath: string, noteText: string): void {
  const entry = `- ${noteText.trim().replace(/^-+\s*/, "")}`;
  if (!fs.existsSync(memoryPath)) {
    fs.writeFileSync(memoryPath, `# MEMORY.md\n\n## ${detectBootSection(noteText)}\n${entry}\n`, "utf-8");
    return;
  }

  const raw = fs.readFileSync(memoryPath, "utf-8");
  const targetSection = detectBootSection(noteText);
  const lines = raw.split(/\r?\n/);
  let sectionStart = -1;
  let sectionEnd = lines.length;

  for (let i = 0; i < lines.length; i += 1) {
    const match = /^(##)\s+(.*)$/.exec(lines[i] || "");
    if (!match) continue;
    if ((match[2] || "").trim().toLowerCase() === targetSection.toLowerCase()) {
      sectionStart = i;
      for (let j = i + 1; j < lines.length; j += 1) {
        if (/^##\s+/.test(lines[j] || "")) {
          sectionEnd = j;
          break;
        }
      }
      break;
    }
  }

  if (sectionStart >= 0) {
    const sectionBody = lines.slice(sectionStart + 1, sectionEnd);
    if (sectionBody.some((line) => line.trim() === entry.trim())) {
      return;
    }
    const insertionIndex = sectionEnd;
    const rebuilt = [
      ...lines.slice(0, insertionIndex),
      entry,
      ...lines.slice(insertionIndex)
    ];
    fs.writeFileSync(memoryPath, `${rebuilt.join("\n").replace(/\n{3,}/g, "\n\n")}\n`, "utf-8");
    return;
  }

  const suffix = raw.endsWith("\n") ? "" : "\n";
  const appended = `${raw}${suffix}\n## ${targetSection}\n${entry}\n`;
  fs.writeFileSync(memoryPath, appended.replace(/\n{3,}/g, "\n\n"), "utf-8");
}

export async function handleAgentEndHeartbeat(
  event: PluginHookAgentEndEvent,
  ctx: PluginHookAgentContext,
  deps: ObservationHookDependencies
): Promise<void> {
  const writebackEnabled = isFeatureEnabled(deps.pluginConfig, "enableAgentWriteback", true);
  if (writebackEnabled && event.success && deps.runtimeState) {
    const { user, assistant } = getLatestMeaningfulTurn(event.messages ?? []);
    const route = classifyWriteback(user, assistant);
    const digest = shaLike(`${user}\n${assistant}\n${route}`);
    const previous = deps.runtimeState.getWritebackState(ctx.sessionKey);
    if (route !== "discard" && previous?.lastDigest !== digest) {
      const agentId = resolveAgentId(ctx, deps.pluginConfig);
      const vaultPath = resolveVaultPathForAgent(deps.pluginConfig, {
        agentId,
        cwd: ctx.workspaceDir
      });
      if (vaultPath) {
        const policy = resolvePolicyText(
          deps.pluginConfig.writebackPolicyPath,
          ctx.workspaceDir,
          path.join("clawvault", "WRITEBACK.md"),
          "ClawVault Writeback Policy: classify as boot, durable, source, or discard; write only concise distilled memory."
        );
        const body = [
          `**Route:** ${route}`,
          "",
          `**User:** ${user || "(none)"}`,
          `**Assistant:** ${assistant || "(none)"}`,
          "",
          "**Policy:**",
          policy
        ].join("\n");

        if (route === "durable") {
          const category = inferDurableCategory(user, assistant);
          const fileTitle = buildDurableTitle(category, user, assistant);
          const noteTitle = `${category.slice(0, 1).toUpperCase()}${category.slice(1)} Memory`;
          writeDurableNote(
            path.join(vaultPath, category, `${fileTitle}.md`),
            noteTitle,
            category,
            body,
            ctx.sessionKey
          );
        } else if (route === "source") {
          appendMarkdownNote(path.join(vaultPath, "sources", "agent-writeback.md"), "Agent Writeback Source", body);
        } else if (route === "boot") {
          upsertMemorySection(path.join(vaultPath, "MEMORY.md"), assistant || user);
        }

        deps.runtimeState.setWritebackState(ctx.sessionKey ?? `agent:${agentId}:unknown`, {
          lastDigest: digest,
          lastRoute: route
        });
      }
    }
  }

  if (!isOptInEnabled(deps.pluginConfig, "enableHeartbeatObservation", "observeOnHeartbeat")) {
    return;
  }

  const agentId = resolveAgentId(ctx, deps.pluginConfig);
  const vaultPath = resolveVaultPathForAgent(deps.pluginConfig, {
    agentId,
    cwd: ctx.workspaceDir
  });
  if (!vaultPath) {
    return;
  }

  if (!shouldObserveActiveSessions(vaultPath, agentId, deps.pluginConfig)) {
    return;
  }

  const observed = runObserverCron(vaultPath, agentId, deps.pluginConfig, {
    reason: "agent_end heartbeat"
  });
  if (!observed) {
    deps.logger?.warn("[clawvault] Heartbeat observation trigger failed");
  }

  if (!event.success && event.error) {
    deps.logger?.info(`[clawvault] Agent ended with error: ${event.error}`);
  }
}

export async function handleBeforeCompactionObservation(
  event: PluginHookBeforeCompactionEvent,
  ctx: PluginHookAgentContext,
  deps: ObservationHookDependencies
): Promise<void> {
  const compactionObserveEnabled = isOptInEnabled(deps.pluginConfig, "enableCompactionObservation");
  const factExtractionEnabled = isOptInEnabled(deps.pluginConfig, "enableFactExtraction");
  if (!compactionObserveEnabled && !factExtractionEnabled) {
    return;
  }

  const agentId = resolveAgentId(ctx, deps.pluginConfig);
  const vaultPath = resolveVaultPathForAgent(deps.pluginConfig, {
    agentId,
    cwd: ctx.workspaceDir
  });
  if (!vaultPath) {
    return;
  }

  if (compactionObserveEnabled) {
    runObserverCron(vaultPath, agentId, deps.pluginConfig, {
      minNewBytes: 1,
      reason: "before_compaction"
    });
  }

  if (factExtractionEnabled) {
    runFactExtractionForEvent(vaultPath, event, "before_compaction");
  }
}
