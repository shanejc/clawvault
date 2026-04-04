import * as fs from "fs";
import * as path from "path";
import type { PluginHookBeforePromptBuildEvent, PluginHookBeforePromptBuildResult, PluginHookAgentContext } from "../openclaw-types.js";
import type { ClawVaultPluginConfig } from "../config.js";
import { isFeatureEnabled } from "../config.js";
import { buildCommunicationProtocolAppendix } from "../communication-protocol.js";
import { buildVaultContextInjection, type VaultContextInjectionResult } from "../vault-context-injector.js";
import type { ClawVaultPluginRuntimeState } from "../runtime-state.js";

const MEMORY_RECALL_ADVISORY = [
  "ClawVault Recall Policy:",
  "- Trigger recall only when continuity matters: prior work, people, decisions, preferences, todos, project state, or history.",
  "- Recall from the smallest sufficient layer before answering; prefer the vault over source files unless chronology or evidence is specifically needed.",
  "- Inject only minimal relevant context and do not guess from stale session memory when recall is available."
].join("\n");

const MEMORY_RECALL_MANDATE = [
  "ClawVault Memory Recall Policy (Strict):",
  "- Before answering anything about prior work, people, decisions, preferences, todos, or historical context, call memory_search first.",
  "- If memory_search returns relevant snippets, ground your answer in those snippets and use memory_get when details are needed.",
  "- Do not guess from stale context when memory lookup is available."
].join("\n");

const CONTINUITY_PATTERNS: RegExp[] = [
  /\b(remember|remind me|what did we|what have we|what was|what were)\b/i,
  /\b(previous|previously|before|earlier|last time|current state|status of|state of)\b/i,
  /\b(decide|decision|agreed|agreement|plan|planned|todo|task|commitment|history)\b/i,
  /\b(project|person|preference|meeting|handoff|context)\b/i,
  /\b(continue|pick up|follow up|where were we|ongoing)\b/i
];

const RECALL_REFRESH_PATTERNS: RegExp[] = [
  /^\s*(no|nope|nah)\b/i,
  /\b(i meant|actually|rather|specifically|different|not that|not x|not the)\b/i,
  /\b(i was talking about|the one on|the meeting on|not .*?, .*?)\b/i
];

const MAX_QUERY_CHARS = 700;

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
      // ignore and continue
    }
  }

  return MEMORY_RECALL_ADVISORY;
}

function toPlainText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((item) => toPlainText(item)).filter(Boolean).join(" ");
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
    if (typeof record.content === "string") return record.content;
    if (Array.isArray(record.content)) return toPlainText(record.content);
  }
  return "";
}

function extractRecentMessages(messages: unknown[]): Array<{ role: string; text: string }> {
  return messages
    .map((message) => {
      if (!message || typeof message !== "object") return null;
      const record = message as Record<string, unknown>;
      const role = typeof record.role === "string" ? record.role.toLowerCase() : "";
      const text = toPlainText(record.content ?? record.text).replace(/\s+/g, " ").trim();
      if (!role || !text) return null;
      return { role, text };
    })
    .filter((entry): entry is { role: string; text: string } => Boolean(entry));
}

function getLatestUserMessage(messages: unknown[]): string {
  const recent = extractRecentMessages(messages);
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    if (recent[i]?.role === "user") return recent[i].text;
  }
  return "";
}

function shouldRefreshRecall(latestUserMessage: string): boolean {
  if (!latestUserMessage.trim()) return false;
  return RECALL_REFRESH_PATTERNS.some((pattern) => pattern.test(latestUserMessage));
}

function shouldRunRecall(latestUserMessage: string, prompt: string, trigger?: string): boolean {
  const normalizedUser = latestUserMessage.trim();
  const normalizedPrompt = prompt.trim();
  if (!normalizedPrompt) return false;

  const normalizedTrigger = (trigger ?? "").trim().toLowerCase();
  if (normalizedTrigger === "session_start" || normalizedTrigger === "resume") {
    return true;
  }

  if (normalizedUser && RECALL_REFRESH_PATTERNS.some((pattern) => pattern.test(normalizedUser))) {
    return true;
  }

  if (normalizedUser) {
    return CONTINUITY_PATTERNS.some((pattern) => pattern.test(normalizedUser));
  }

  if (normalizedPrompt.length > 400) {
    return true;
  }

  return CONTINUITY_PATTERNS.some((pattern) => pattern.test(normalizedPrompt));
}

function buildRecallQuery(messages: unknown[], latestUserMessage: string, previousQuery?: string): string {
  const recent = extractRecentMessages(messages).slice(-4);
  const recentWindow = recent.map((entry) => `${entry.role}: ${entry.text}`).join("\n");
  const parts = [latestUserMessage.trim()];
  if (recentWindow && !recentWindow.includes(latestUserMessage.trim())) {
    parts.push(recentWindow);
  } else if (recentWindow) {
    parts.push(recentWindow);
  }
  if (previousQuery && shouldRefreshRecall(latestUserMessage)) {
    parts.push(`Previous recall topic: ${previousQuery}`);
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

  return async (event, ctx) => {
    const prependSections: string[] = [];
    const appendSections: string[] = [];

    const recallEnabled = isFeatureEnabled(dependencies.pluginConfig, "enableBeforePromptRecall", false);
    const strictRecallEnabled = isFeatureEnabled(dependencies.pluginConfig, "enableStrictBeforePromptRecall", false);
    const protocolEnabled = isFeatureEnabled(dependencies.pluginConfig, "enforceCommunicationProtocol", false);
    const contextInjectionEnabled = isFeatureEnabled(dependencies.pluginConfig, "enableSessionContextInjection", false);
    const latestUserMessage = getLatestUserMessage(event.messages);
    const existingRecallState = dependencies.runtimeState.getRecallState(ctx.sessionKey);
    const recallNeeded = recallEnabled && shouldRunRecall(latestUserMessage, event.prompt, ctx.trigger);
    const recallRefresh = shouldRefreshRecall(latestUserMessage);
    const recallQuery = recallNeeded
      ? buildRecallQuery(event.messages, latestUserMessage, existingRecallState?.lastQueryText)
      : "";

    if (recallNeeded) {
      const defaultPolicy = strictRecallEnabled ? MEMORY_RECALL_MANDATE : MEMORY_RECALL_ADVISORY;
      const configuredPolicy = resolveRecallPolicyText(dependencies.pluginConfig, ctx.workspaceDir);
      prependSections.push(strictRecallEnabled ? defaultPolicy : configuredPolicy);
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
      if (recallRefresh) {
        dependencies.runtimeState.clearRecallState(ctx.sessionKey);
      }

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

      if (ctx.sessionKey) {
        dependencies.runtimeState.setRecallState(ctx.sessionKey, {
          lastTriggerText: latestUserMessage || event.prompt,
          lastQueryText: recallQuery || event.prompt,
          lastResultDigest: buildResultDigest(injection.prependSystemContext)
        });
      }
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
