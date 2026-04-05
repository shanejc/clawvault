import * as fs from "fs";
import * as path from "path";
import type { PluginHookAgentContext, PluginHookAgentEndEvent, PluginHookBeforeCompactionEvent } from "../openclaw-types.js";
import type { ClawVaultPluginConfig } from "../config.js";
import { isOptInEnabled, resolveAgentId } from "../config.js";
import { resolveVaultPathForAgent, runObserverCron, shouldObserveActiveSessions } from "../clawvault-cli.js";
import { runFactExtractionForEvent } from "../fact-extractor.js";

export interface ObservationHookDependencies {
  pluginConfig: ClawVaultPluginConfig;
  logger?: {
    info: (message: string) => void;
    warn: (message: string) => void;
  };
}

// ─── Writeback types ──────────────────────────────────────────────────────────

type WritebackRoute = "boot" | "durable" | "source" | "discard";

type DurableCategory =
  | "facts" | "feelings" | "decisions" | "lessons"
  | "commitments" | "preferences" | "people" | "projects"
  | "meetings" | "systems";

type MemoryType =
  | "fact" | "feeling" | "decision" | "lesson"
  | "commitment" | "preference" | "relationship" | "project";

interface WritebackState {
  lastDigest: string;
  lastRoute: WritebackRoute;
  updatedAt: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(toText).filter(Boolean).join(" ");
  if (value && typeof value === "object") {
    const r = value as Record<string, unknown>;
    return toText(r.content ?? r.text ?? "");
  }
  return "";
}

function isMeaningfulText(text: string): boolean {
  const t = text.trim();
  if (!t || t.length < 24) return false;
  if (/^(ok|okay|thanks|thank you|done|yes|no|cool|great|got it)[.!]*$/i.test(t)) return false;
  return true;
}

function getLatestMeaningfulTurn(messages: unknown[]): { user: string; assistant: string } {
  if (!Array.isArray(messages)) return { user: "", assistant: "" };

  const parsed = messages
    .map((m) => {
      if (!m || typeof m !== "object") return null;
      const r = m as Record<string, unknown>;
      const role = typeof r.role === "string" ? r.role.toLowerCase() : "";
      const text = toText(r.content ?? r.text).replace(/\s+/g, " ").trim();
      return role && text ? { role, text } : null;
    })
    .filter((e): e is { role: string; text: string } => Boolean(e));

  let assistant = "";
  let user = "";

  for (let i = parsed.length - 1; i >= 0; i--) {
    const e = parsed[i];
    if (!assistant && e.role === "assistant" && isMeaningfulText(e.text)) {
      assistant = e.text;
    } else if (!user && e.role === "user" && isMeaningfulText(e.text)) {
      user = e.text;
    }
    if (user && assistant) break;
  }

  if (!assistant || !user) {
    for (let i = parsed.length - 1; i >= 0; i--) {
      const e = parsed[i];
      if (!assistant && e.role === "assistant") assistant = e.text;
      else if (!user && e.role === "user") user = e.text;
      if (user && assistant) break;
    }
  }

  return { user, assistant };
}

function digest(input: string): string {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) - h + input.charCodeAt(i)) | 0;
  }
  return String(h);
}

function classifyRoute(user: string, assistant: string): WritebackRoute {
  const combined = `${user}\n${assistant}`.toLowerCase();
  if (!combined.trim()) return "discard";
  if (/\b(name:|timezone:|what to call|voice:|identity|role:)\b/.test(combined)) return "boot";
  if (/\b(decided|decision|agreed|will treat|resolved|preference|policy|meeting|action item|current state|remember|use this|treat .* as|took care of)\b/.test(combined)) return "durable";
  if (combined.length > 900) return "source";
  return "discard";
}

function inferDurableCategory(user: string, assistant: string): DurableCategory {
  const combined = `${user}\n${assistant}`.toLowerCase();
  if (/\bmeeting\b|\baction item\b|\binvitation\b/.test(combined)) return "meetings";
  if (/\bplugin\b|\brecall\b|\bwriteback\b|\bopenclaw\b|\bclawvault\b|\bsystem\b/.test(combined)) return "systems";
  if (/\bdecid\w*\b|\bagreed\b|\bresolved\b|\bpolicy\b/.test(combined)) return "decisions";
  if (/\bprefer\w*\b|\bwhat to call\b|\bvoice\b/i.test(`${user}\n${assistant}`)) return "preferences";
  if (/\bproject\b|\bcurrent state\b|\bongoing\b/.test(combined)) return "projects";
  if (/\bshane\b|\btim\b|\bbrian\b|\bperson\b|\bpeople\b/.test(combined)) return "people";
  if (/\bcommit\w*\b|\bwill\b|\bneed to\b|\btodo\b|\btask\b/.test(combined)) return "commitments";
  if (/\blearned\b|\blesson\b|\bmistake\b/.test(combined)) return "lessons";
  if (/\bfeel\b|\bemotion\b|\bmood\b/.test(combined)) return "feelings";
  return "facts";
}

function categoryToMemoryType(cat: DurableCategory): MemoryType {
  const map: Record<DurableCategory, MemoryType> = {
    facts: "fact", feelings: "feeling", decisions: "decision",
    lessons: "lesson", commitments: "commitment", preferences: "preference",
    people: "relationship", projects: "project", meetings: "decision", systems: "decision"
  };
  return map[cat];
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s-]/g, "").trim().replace(/\s+/g, "-").replace(/-+/g, "-").slice(0, 80) || "memory";
}

function resolveWritebackPolicyText(pluginConfig: ClawVaultPluginConfig, workspaceDir?: string): string {
  const candidates: string[] = [];
  if (typeof pluginConfig.writebackPolicyPath === "string" && pluginConfig.writebackPolicyPath.trim()) {
    const p = pluginConfig.writebackPolicyPath.trim();
    candidates.push(path.isAbsolute(p) ? p : path.resolve(workspaceDir ?? process.cwd(), p));
  }
  if (workspaceDir) {
    candidates.push(path.join(workspaceDir, "clawvault", "WRITEBACK.md"));
  }
  for (const c of candidates) {
    try {
      const text = fs.readFileSync(c, "utf-8").trim();
      if (text) return text;
    } catch { /* ignore */ }
  }
  return "";
}

function writeDurable(vaultPath: string, category: DurableCategory, memoryType: MemoryType, slug: string, body: string, sessionKey?: string): void {
  const dir = path.join(vaultPath, category);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${slug}.md`);
  const now = new Date().toISOString();
  const frontmatter = [
    "---",
    `title: "${slug.replace(/-/g, " ")}"`,
    `memory_type: ${memoryType}`,
    `created: ${now}`,
    `source_type: conversation`,
    sessionKey ? `session_key: "${sessionKey}"` : null,
    `origin: agent_writeback`,
    "---",
    ""
  ].filter(Boolean).join("\n");
  fs.writeFileSync(filePath, `${frontmatter}${body.trim()}\n`, "utf-8");
}

function writeSource(vaultPath: string, body: string): void {
  const dir = path.join(vaultPath, "sources");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, "agent-writeback.md");
  const now = new Date().toISOString();
  const entry = `\n\n## ${now}\n\n${body.trim()}\n`;
  if (fs.existsSync(filePath)) {
    fs.appendFileSync(filePath, entry, "utf-8");
  } else {
    fs.writeFileSync(filePath, `# Agent Writeback Sources${entry}`, "utf-8");
  }
}

function writeBoot(workspaceDir: string, note: string): void {
  const memoryPath = path.join(workspaceDir, "MEMORY.md");
  if (!fs.existsSync(memoryPath)) return;
  const existing = fs.readFileSync(memoryPath, "utf-8");
  const entry = `- ${note.trim().replace(/^-+\s*/, "")}`;
  // Append under a "Boot Notes" section if it exists, else append at end
  if (existing.includes("## Boot Notes")) {
    const updated = existing.replace(/(## Boot Notes\n)([\s\S]*?)(\n## |$)/, (_, h, body, next) => {
      return `${h}${body.trim()}\n${entry}\n${next}`;
    });
    fs.writeFileSync(memoryPath, updated, "utf-8");
  } else {
    fs.appendFileSync(memoryPath, `\n## Boot Notes\n${entry}\n`, "utf-8");
  }
}

// ─── Writeback handler factory ────────────────────────────────────────────────

export function createAgentEndWritebackHandler(
  pluginConfig: ClawVaultPluginConfig
): (event: PluginHookAgentEndEvent, ctx: PluginHookAgentContext, deps: ObservationHookDependencies) => Promise<void> {
  const stateBySession = new Map<string, WritebackState>();

  return async (event, ctx, deps) => {
    const enabled = pluginConfig.enableAgentWriteback !== false &&
      (pluginConfig.enableAgentWriteback === true ||
        !Object.prototype.hasOwnProperty.call(pluginConfig, "enableAgentWriteback"));

    if (!enabled) return;

    const workspaceDir = ctx.workspaceDir;
    const vaultPath = resolveVaultPathForAgent(pluginConfig, {
      agentId: resolveAgentId(ctx, pluginConfig),
      cwd: workspaceDir
    });

    if (!vaultPath) return;

    // Load writeback policy (for future LLM-backed classification — for now purely diagnostic)
    resolveWritebackPolicyText(pluginConfig, workspaceDir);

    const messages: unknown[] = Array.isArray((event as Record<string, unknown>).messages)
      ? (event as Record<string, unknown>).messages as unknown[]
      : [];

    const { user, assistant } = getLatestMeaningfulTurn(messages);
    if (!user && !assistant) return;

    const combined = `${user}\n${assistant}`;
    const turnDigest = digest(combined);

    const sessionKey = ctx.sessionKey ?? "";
    const prior = sessionKey ? stateBySession.get(sessionKey) : undefined;
    if (prior?.lastDigest === turnDigest) return; // duplicate — skip

    const route = classifyRoute(user, assistant);

    if (route === "discard") {
      if (sessionKey) {
        stateBySession.set(sessionKey, { lastDigest: turnDigest, lastRoute: "discard", updatedAt: new Date().toISOString() });
      }
      return;
    }

    try {
      if (route === "durable") {
        const category = inferDurableCategory(user, assistant);
        const memoryType = categoryToMemoryType(category);
        const slug = slugify(user.split(/[.!?\n]/)[0] ?? category);
        const body = `**User:** ${user.trim()}\n\n**Assistant:** ${assistant.trim()}`;
        writeDurable(vaultPath, category, memoryType, slug, body, sessionKey || undefined);
      } else if (route === "source") {
        const body = `**User:** ${user.trim()}\n\n**Assistant:** ${assistant.trim()}`;
        writeSource(vaultPath, body);
      } else if (route === "boot" && workspaceDir) {
        writeBoot(workspaceDir, assistant.trim().slice(0, 300));
      }

      if (sessionKey) {
        stateBySession.set(sessionKey, { lastDigest: turnDigest, lastRoute: route, updatedAt: new Date().toISOString() });
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      deps.logger?.warn(`[clawvault] writeback failed (${route}): ${detail}`);
    }
  };
}

// ─── Existing heartbeat / compaction hooks (unchanged) ───────────────────────

export async function handleAgentEndHeartbeat(
  event: PluginHookAgentEndEvent,
  ctx: PluginHookAgentContext,
  deps: ObservationHookDependencies
): Promise<void> {
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
