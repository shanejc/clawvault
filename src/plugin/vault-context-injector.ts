import type { ClawVaultPluginConfig } from "./config.js";
import { resolveVaultPathForAgent, runClawvault, parseContextJson, parseSessionRecapJson, formatSessionContextInjection, sanitizePromptForContext, resolveSessionKey, type ContextEntry, type SessionRecapEntry } from "./clawvault-cli.js";

const DEFAULT_MAX_CONTEXT_RESULTS = 4;
const DEFAULT_MAX_RECAP_RESULTS = 6;

export interface VaultContextInjectorOptions {
  prompt: string;
  sessionKey?: string;
  agentId?: string;
  workspaceDir?: string;
  pluginConfig: ClawVaultPluginConfig;
  contextProfile?: "default" | "planning" | "incident" | "handoff" | "auto";
  maxResults?: number;
}

export interface VaultContextInjectionResult {
  prependSystemContext: string;
  memoryEntries: ContextEntry[];
  recapEntries: SessionRecapEntry[];
  vaultPath: string | null;
}

export async function fetchSessionRecapEntries(
  options: Pick<VaultContextInjectorOptions, "sessionKey" | "agentId" | "pluginConfig">
): Promise<SessionRecapEntry[]> {
  const sessionKey = resolveSessionKey(options.sessionKey);
  if (!sessionKey) return [];

  const recapArgs = ["session-recap", sessionKey, "--format", "json"];
  if (options.agentId) {
    recapArgs.push("--agent", options.agentId);
  }

  const recapResult = runClawvault(recapArgs, options.pluginConfig, { timeoutMs: 20_000 });
  if (!recapResult.success) {
    return [];
  }

  return parseSessionRecapJson(recapResult.output, DEFAULT_MAX_RECAP_RESULTS);
}

export async function fetchMemoryContextEntries(
  options: VaultContextInjectorOptions
): Promise<{ entries: ContextEntry[]; vaultPath: string | null }> {
  const prompt = sanitizePromptForContext(options.prompt);
  if (!prompt) {
    return { entries: [], vaultPath: null };
  }

  const vaultPath = resolveVaultPathForAgent(options.pluginConfig, {
    agentId: options.agentId,
    cwd: options.workspaceDir
  });
  if (!vaultPath) {
    return { entries: [], vaultPath: null };
  }

  const maxResults = Number.isFinite(options.maxResults)
    ? Math.max(1, Math.min(20, Number(options.maxResults)))
    : DEFAULT_MAX_CONTEXT_RESULTS;
  const profile = options.contextProfile ?? options.pluginConfig.contextProfile ?? "auto";

  const contextArgs = [
    "context",
    prompt,
    "--format",
    "json",
    "--profile",
    profile,
    "--limit",
    String(maxResults),
    "-v",
    vaultPath
  ];
  const contextResult = runClawvault(contextArgs, options.pluginConfig, { timeoutMs: 25_000 });
  if (!contextResult.success) {
    return { entries: [], vaultPath };
  }

  return {
    entries: parseContextJson(contextResult.output, maxResults),
    vaultPath
  };
}

export async function buildVaultContextInjection(
  options: VaultContextInjectorOptions
): Promise<VaultContextInjectionResult> {
  const [recapEntries, memoryResult] = await Promise.all([
    fetchSessionRecapEntries(options),
    fetchMemoryContextEntries(options)
  ]);

  if (recapEntries.length === 0 && memoryResult.entries.length === 0) {
    return {
      prependSystemContext: "",
      memoryEntries: [],
      recapEntries: [],
      vaultPath: memoryResult.vaultPath
    };
  }

  return {
    prependSystemContext: formatSessionContextInjection(recapEntries, memoryResult.entries),
    memoryEntries: memoryResult.entries,
    recapEntries,
    vaultPath: memoryResult.vaultPath
  };
}
