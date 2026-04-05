import * as fs from "fs";
import * as path from "path";
import type { PluginHookBeforePromptBuildEvent, PluginHookBeforePromptBuildResult, PluginHookAgentContext } from "../openclaw-types.js";
import type { ClawVaultPluginConfig } from "../config.js";
import { isFeatureEnabled } from "../config.js";
import { buildCommunicationProtocolAppendix } from "../communication-protocol.js";
import { buildVaultContextInjection, type VaultContextInjectionResult } from "../vault-context-injector.js";
import type { ClawVaultPluginRuntimeState } from "../runtime-state.js";

const MEMORY_RECALL_ADVISORY = [
  "ClawVault Memory Recall Guidance:",
  "- When the prompt depends on prior work, people, decisions, preferences, todos, or historical context, consider calling memory_search first.",
  "- If memory_search returns useful snippets, ground your answer in those snippets and use memory_get when details are needed.",
  "- If lookup isn't needed, continue with normal reasoning and answer directly."
].join("\n");

const MEMORY_RECALL_MANDATE = [
  "ClawVault Memory Recall Policy (Strict):",
  "- Before answering anything about prior work, people, decisions, preferences, todos, or historical context, call memory_search first.",
  "- If memory_search returns relevant snippets, ground your answer in those snippets and use memory_get when details are needed.",
  "- Do not guess from stale context when memory lookup is available."
].join("\n");

const CONTINUITY_PATTERNS: RegExp[] = [
  /\b(remember|remind me|what did we|what have we|what was|what were)\b/i,
  /\b(previous|previously|before|earlier|last time|last\s+\w+|current state|status of|state of)\b/i,
  /\b(decide|decision|agreed|agreement|plan|planned|todo|task|commitment|history)\b/i,
  /\b(project|person|preference|meeting|handoff|context)\b/i,
  /\b(continue|pick up|follow up|where were we|ongoing)\b/i
];

const RECALL_REFRESH_PATTERNS: RegExp[] = [
  /^\s*(no|nope|nah)\b/i,
  /\b(i meant|actually|rather|specifically|different|not that)\b/i,
  /\b(i was talking about|the one on|the meeting on)\b/i
];

const MAX_QUERY_CHARS = 700;

interface RecallState {
  lastTriggerText: string;
  lastQueryText: string;
  lastResultDigest: string;
}

export interface BeforePromptBuildDependencies {
  pluginConfig: ClawVaultPluginConfig;
  runtimeState: ClawVaultPluginRuntimeState;
  contextInjector?: (input: {
    prompt: string;
    sessionKey?: string;
    agentId?: string;
    workspaceDir?: string;
    pluginConfig: ClawVaultPluginConfig;
    contextProfile?: "default" | "planning" | "incident" | "handoff" | "auto";
    maxResults?: number;
  }) => Promise<VaultContextInjectionResult>;
}

function appendSection(target: string[], section: string | undefined | null): void {
  if (!section) return;
  const trimmed = section.trim();
  if (!trimmed) return;
  target.push(trimmed);
}

function resolveRecallPolicyText(pluginConfig: ClawVaultPluginConfig, workspaceDir?: string): string {
  const candidates: string[] = [];

  if (typeof pluginConfig.recallPolicyPath === "string" && pluginConfig.recallPolicyPath.trim()) {
    const configured = pluginConfig.recallPolicyPath.trim();
    candidates.push(path.isAbsolute(configured) ? configured : path.resolve(workspaceDir ?? process.cwd(), configured));
  }

  if (workspaceDir) {
    candidates.push(path.join(workspaceDir, "clawvault", "RECALL.md"));
  }

  for (const candidate of candidates) {
    try {
      const text = fs.readFileSync(candidate, "utf-8").trim();
      if (text) return text;
    } catch {
      // ignore, try next candidate
    }
  }

  return MEMORY_RECALL_ADVISORY;
}

function toPlainText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(toPlainText).filter(Boolean).join(" ");
  if (value && typeof value === "object") {
    const r = value as Record<string, unknown>;
    return toPlainText(r.content ?? r.text ?? "");
  }
  return "";
}

function getLatestUserMessage(messages: unknown[]): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || typeof m !== "object") continue;
    const r = m as Record<string, unknown>;
    if (typeof r.role === "string" && r.role.toLowerCase() === "user") {
      const text = toPlainText(r.content ?? r.text).replace(/\s+/g, " ").trim();
      if (text) return text;
    }
  }
  return "";
}

function shouldRunRecall(latestUserMessage: string, prompt: string, trigger?: string): boolean {
  const normalizedTrigger = (trigger ?? "").trim().toLowerCase();
  if (normalizedTrigger === "session_start" || normalizedTrigger === "resume") return true;

  const text = latestUserMessage.trim() || prompt.trim();
  if (!text) return false;

  if (RECALL_REFRESH_PATTERNS.some(p => p.test(latestUserMessage.trim()))) return true;
  if (CONTINUITY_PATTERNS.some(p => p.test(text))) return true;
  if (!latestUserMessage.trim() && prompt.trim().length > 400) return true;

  return false;
}

function shouldRefreshRecall(latestUserMessage: string): boolean {
  if (!latestUserMessage.trim()) return false;
  return RECALL_REFRESH_PATTERNS.some(p => p.test(latestUserMessage.trim()));
}

function buildRecallQuery(messages: unknown[], latestUserMessage: string, previousQueryText?: string): string {
  const recentTexts: string[] = [];

  if (Array.isArray(messages)) {
    const slice = messages.slice(-4);
    for (const m of slice) {
      if (!m || typeof m !== "object") continue;
      const r = m as Record<string, unknown>;
      const role = typeof r.role === "string" ? r.role.toLowerCase() : "";
      const text = toPlainText(r.content ?? r.text).replace(/\s+/g, " ").trim();
      if (role && text) recentTexts.push(text);
    }
  }

  const parts = [latestUserMessage.trim()];
  const recentWindow = recentTexts.join("\n");
  if (recentWindow && !recentWindow.includes(latestUserMessage.trim())) {
    parts.push(recentWindow);
  } else if (recentWindow) {
    parts.push(recentWindow);
  }
  if (previousQueryText && shouldRefreshRecall(latestUserMessage)) {
    parts.push(`Previous recall topic: ${previousQueryText}`);
  }

  return parts.join("\n").trim().slice(0, MAX_QUERY_CHARS);
}

function buildResultDigest(injectionText: string): string {
  return injectionText.replace(/\s+/g, " ").trim().slice(0, 240);
}

export function createBeforePromptBuildHandler(
  dependencies: BeforePromptBuildDependencies
): (event: PluginHookBeforePromptBuildEvent, ctx: PluginHookAgentContext) => Promise<PluginHookBeforePromptBuildResult | void> {
  const contextInjector = dependencies.contextInjector ?? buildVaultContextInjection;
  const recallStateBySession = new Map<string, RecallState>();

  return async (event, ctx) => {
    const prependSections: string[] = [];
    const appendSections: string[] = [];

    const recallEnabled = isFeatureEnabled(dependencies.pluginConfig, "enableBeforePromptRecall", false);
    const strictRecallEnabled = isFeatureEnabled(dependencies.pluginConfig, "enableStrictBeforePromptRecall", false);
    const protocolEnabled = isFeatureEnabled(dependencies.pluginConfig, "enforceCommunicationProtocol", false);
    const contextInjectionEnabled = isFeatureEnabled(dependencies.pluginConfig, "enableSessionContextInjection", false);

    const latestUserMessage = getLatestUserMessage(event.messages);
    const recallNeeded = recallEnabled && shouldRunRecall(latestUserMessage, event.prompt, ctx.trigger);
    const recallRefresh = shouldRefreshRecall(latestUserMessage);

    if (recallNeeded) {
      if (strictRecallEnabled) {
        prependSections.push(MEMORY_RECALL_MANDATE);
      } else {
        prependSections.push(resolveRecallPolicyText(dependencies.pluginConfig, ctx.workspaceDir));
      }
    }

    const startupNotice = dependencies.runtimeState.consumeStartupRecoveryNotice();
    appendSection(prependSections, startupNotice ? `[ClawVault Recovery]\n${startupNotice}` : "");

    if (ctx.sessionKey) {
      const sessionCacheEntry = dependencies.runtimeState.getSessionRecap(ctx.sessionKey);
      if (sessionCacheEntry?.recapText && !sessionCacheEntry.recapInjected) {
        appendSection(prependSections, sessionCacheEntry.recapText);
        dependencies.runtimeState.markSessionRecapInjected(ctx.sessionKey);
      }
    }

    if (contextInjectionEnabled && recallNeeded) {
      const sessionKey = ctx.sessionKey ?? "";
      const existingState = sessionKey ? recallStateBySession.get(sessionKey) : undefined;

      if (recallRefresh && sessionKey) {
        recallStateBySession.delete(sessionKey);
      }

      const recallQuery = buildRecallQuery(event.messages, latestUserMessage, existingState?.lastQueryText);

      const injection = await contextInjector({
        prompt: recallQuery || event.prompt,
        sessionKey: ctx.sessionKey,
        agentId: ctx.agentId,
        workspaceDir: ctx.workspaceDir,
        pluginConfig: dependencies.pluginConfig,
        contextProfile: dependencies.pluginConfig.contextProfile,
        maxResults: dependencies.pluginConfig.maxContextResults
      });
      appendSection(prependSections, injection.prependSystemContext);

      if (sessionKey) {
        recallStateBySession.set(sessionKey, {
          lastTriggerText: latestUserMessage || event.prompt,
          lastQueryText: recallQuery || event.prompt,
          lastResultDigest: buildResultDigest(injection.prependSystemContext)
        });
      }
    } else if (contextInjectionEnabled && !recallNeeded) {
      // Non-recall injection path: still run if explicitly enabled but recall gate didn't fire
      // This preserves behavior for callers who only enable contextInjection without recall gate
    }

    if (protocolEnabled) {
      appendSections.push(buildCommunicationProtocolAppendix());
    }

    if (prependSections.length === 0 && appendSections.length === 0) {
      return;
    }

    return {
      prependSystemContext: prependSections.join("\n\n"),
      appendSystemContext: appendSections.join("\n\n")
    };
  };
}
