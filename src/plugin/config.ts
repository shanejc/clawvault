import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type {
  ClawVaultCallbackPayload,
  ClawVaultCallbackResult,
  OpenClawPluginApi,
  PluginHookAgentContext
} from "./openclaw-types.js";
import {
  CLAWVAULT_PACK_NAMES,
  PACK_FEATURE_KEYS,
  PACK_PRESET_DOMAIN_MODES,
  isClawVaultPackPreset
} from "./packs.js";
import type { ClawVaultAutomationPack, ClawVaultPackPreset, ClawVaultPackToggleMap } from "./packs.js";

const SESSION_KEY_RE = /^agent:[a-zA-Z0-9_-]+:[a-zA-Z0-9:_-]+$/;
const AGENT_ID_RE = /^[a-zA-Z0-9_-]{1,100}$/;

export type ClawVaultContextProfile = "default" | "planning" | "incident" | "handoff" | "auto";
export type ClawVaultMemoryBehaviorMode = "off" | "auto" | "callback";
export type ClawVaultMemoryBehaviorDomainMap = Partial<Record<ClawVaultAutomationPack, ClawVaultMemoryBehaviorMode>>;
export type ClawVaultCallbackPolicy = "legacy" | "fallbackToAuto" | "skip" | "hardFail";
export type ClawVaultCallbackPolicyMap = Partial<Record<ClawVaultAutomationPack, ClawVaultCallbackPolicy>>;
export type ClawVaultMemoryBehaviorCallback = (
  payload: ClawVaultCallbackPayload
) => ClawVaultCallbackResult | Promise<ClawVaultCallbackResult>;
export type ClawVaultMemoryBehaviorCallbackMap = Partial<Record<ClawVaultAutomationPack, ClawVaultMemoryBehaviorCallback>>;

export interface ClawVaultPluginConfig {
  automationMode?: boolean;
  automationPreset?: "thin" | "hybrid" | "legacy" | "automation";
  packPreset?: ClawVaultPackPreset;
  packToggles?: ClawVaultPackToggleMap;
  memoryBehaviorDomains?: ClawVaultMemoryBehaviorDomainMap;
  memoryBehaviorCallbacks?: ClawVaultMemoryBehaviorCallbackMap;
  memoryBehaviorCallbackTimeoutMs?: number;
  memoryBehaviorCallbackPolicy?: ClawVaultCallbackPolicy;
  memoryBehaviorCallbackPolicies?: ClawVaultCallbackPolicyMap;
  vaultPath?: string;
  agentVaults?: Record<string, string>;
  allowClawvaultExec?: boolean;
  clawvaultBinaryPath?: string;
  clawvaultBinarySha256?: string;
  allowEnvAccess?: boolean;
  enableStartupRecovery?: boolean;
  enableSessionContextInjection?: boolean;
  enableAutoCheckpoint?: boolean;
  enableObserveOnNew?: boolean;
  enableHeartbeatObservation?: boolean;
  enableCompactionObservation?: boolean;
  enableWeeklyReflection?: boolean;
  enableFactExtraction?: boolean;
  autoCheckpoint?: boolean;
  observeOnHeartbeat?: boolean;
  weeklyReflection?: boolean;
  contextProfile?: ClawVaultContextProfile;
  maxContextResults?: number;
  enableBeforePromptRecall?: boolean;
  enableStrictBeforePromptRecall?: boolean;
  recallPolicyPath?: string;
  enforceCommunicationProtocol?: boolean;
  enableMessageSendingFilter?: boolean;
  minQuestionRecallScore?: number;
  memoryOverlayFolders?: string[];
  memorySourceOverlayFolders?: string[];
  allowDefaultCategoryOverride?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function readPluginConfig(api: Pick<OpenClawPluginApi, "pluginConfig">): ClawVaultPluginConfig {
  if (!isRecord(api.pluginConfig)) {
    return {};
  }
  return api.pluginConfig as ClawVaultPluginConfig;
}


function isPackFeatureKey(key: keyof ClawVaultPluginConfig): boolean {
  return CLAWVAULT_PACK_NAMES.some((pack) => PACK_FEATURE_KEYS[pack].includes(key));
}

function getEffectivePackPreset(pluginConfig: ClawVaultPluginConfig): ClawVaultPackPreset | null {
  const preset = pluginConfig.packPreset ?? pluginConfig.automationPreset;
  if (!isClawVaultPackPreset(preset)) return null;
  return preset;
}

function isMemoryBehaviorMode(value: unknown): value is ClawVaultMemoryBehaviorMode {
  return value === "off" || value === "auto" || value === "callback";
}

function isCallbackPolicy(value: unknown): value is ClawVaultCallbackPolicy {
  return value === "legacy" || value === "fallbackToAuto" || value === "skip" || value === "hardFail";
}

/**
 * Domain mode precedence:
 * 1) explicit memoryBehaviorDomains.<pack> mode
 * 2) explicit packToggles.<pack> boolean
 * 3) automationMode=true fallback
 * 4) packPreset/automationPreset default domain mode
 * 5) off
 */
export function getPackBehaviorMode(
  pluginConfig: ClawVaultPluginConfig,
  pack: ClawVaultAutomationPack
): ClawVaultMemoryBehaviorMode {
  const explicitDomainMode = pluginConfig.memoryBehaviorDomains?.[pack];
  if (isMemoryBehaviorMode(explicitDomainMode)) {
    return explicitDomainMode;
  }

  const explicitToggle = pluginConfig.packToggles?.[pack];
  if (typeof explicitToggle === "boolean") {
    return explicitToggle ? "auto" : "off";
  }

  if (pluginConfig.automationMode === true) {
    return "auto";
  }

  const preset = getEffectivePackPreset(pluginConfig);
  if (!preset) return "off";

  return PACK_PRESET_DOMAIN_MODES[preset][pack];
}

export function getPackCallbackPolicy(
  pluginConfig: ClawVaultPluginConfig,
  pack: ClawVaultAutomationPack
): ClawVaultCallbackPolicy {
  const perPackPolicy = pluginConfig.memoryBehaviorCallbackPolicies?.[pack];
  if (isCallbackPolicy(perPackPolicy)) {
    return perPackPolicy;
  }

  if (isCallbackPolicy(pluginConfig.memoryBehaviorCallbackPolicy)) {
    return pluginConfig.memoryBehaviorCallbackPolicy;
  }

  return "legacy";
}

export function isPackEnabled(pluginConfig: ClawVaultPluginConfig, pack: ClawVaultAutomationPack): boolean {
  return getPackBehaviorMode(pluginConfig, pack) !== "off";
}

export function isOptInEnabled(pluginConfig: ClawVaultPluginConfig, ...keys: Array<keyof ClawVaultPluginConfig>): boolean {
  return keys.some((key) => isFeatureEnabled(pluginConfig, key, false));
}

export function isFeatureEnabled(
  pluginConfig: ClawVaultPluginConfig,
  key: keyof ClawVaultPluginConfig,
  defaultValue: boolean
): boolean {
  const value = pluginConfig[key];
  if (typeof value === "boolean") return value;

  if (isPackFeatureKey(key)) {
    const ownerPack = CLAWVAULT_PACK_NAMES.find((pack) => PACK_FEATURE_KEYS[pack].includes(key));
    if (ownerPack) {
      return isPackEnabled(pluginConfig, ownerPack);
    }
  }

  return defaultValue;
}

export function allowsEnvAccess(pluginConfig: ClawVaultPluginConfig): boolean {
  return isOptInEnabled(pluginConfig, "allowEnvAccess");
}

export function sanitizeSessionKey(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!SESSION_KEY_RE.test(trimmed)) return "";
  return trimmed.slice(0, 200);
}

export function sanitizeAgentId(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!AGENT_ID_RE.test(trimmed)) return "";
  return trimmed;
}

export function extractAgentIdFromSessionKey(sessionKey: string): string {
  const match = /^agent:([^:]+):/.exec(sessionKey);
  if (!match?.[1]) return "";
  return sanitizeAgentId(match[1]);
}

export function resolveAgentId(
  ctx: Pick<PluginHookAgentContext, "agentId" | "sessionKey">,
  pluginConfig: ClawVaultPluginConfig
): string {
  const fromContext = sanitizeAgentId(ctx.agentId);
  if (fromContext) return fromContext;

  const fromSessionKey = extractAgentIdFromSessionKey(sanitizeSessionKey(ctx.sessionKey));
  if (fromSessionKey) return fromSessionKey;

  if (allowsEnvAccess(pluginConfig)) {
    const fromEnv = sanitizeAgentId(process.env.OPENCLAW_AGENT_ID);
    if (fromEnv) return fromEnv;
  }

  return "main";
}

export function getConfiguredExecutablePath(pluginConfig: ClawVaultPluginConfig): string | null {
  if (typeof pluginConfig.clawvaultBinaryPath !== "string") return null;
  const trimmed = pluginConfig.clawvaultBinaryPath.trim();
  return trimmed || null;
}

export function getConfiguredExecutableSha256(pluginConfig: ClawVaultPluginConfig): string | null {
  if (typeof pluginConfig.clawvaultBinarySha256 !== "string") return null;
  const trimmed = pluginConfig.clawvaultBinarySha256.trim().toLowerCase();
  return trimmed || null;
}

function normalizeAbsoluteEnvPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const resolved = path.resolve(trimmed);
  if (!path.isAbsolute(resolved)) return null;
  return resolved;
}

export function getOpenClawAgentsDir(pluginConfig: ClawVaultPluginConfig): string {
  if (allowsEnvAccess(pluginConfig)) {
    const stateDir = normalizeAbsoluteEnvPath(process.env.OPENCLAW_STATE_DIR);
    if (stateDir) {
      return path.join(stateDir, "agents");
    }

    const openClawHome = normalizeAbsoluteEnvPath(process.env.OPENCLAW_HOME);
    if (openClawHome) {
      return path.join(openClawHome, "agents");
    }
  }

  return path.join(os.homedir(), ".openclaw", "agents");
}

export function validateVaultPath(vaultPath: string | undefined | null): string | null {
  if (!vaultPath || typeof vaultPath !== "string") return null;

  const resolved = path.resolve(vaultPath);
  if (!path.isAbsolute(resolved)) return null;

  try {
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) return null;
  } catch {
    return null;
  }

  const configPath = path.join(resolved, ".clawvault.json");
  if (!fs.existsSync(configPath)) return null;

  return resolved;
}

function resolveAgentVaultPath(pluginConfig: ClawVaultPluginConfig, agentId: string): string | null {
  if (!agentId) return null;
  if (!isRecord(pluginConfig.agentVaults)) return null;

  const configured = pluginConfig.agentVaults[agentId];
  if (typeof configured !== "string") return null;
  return validateVaultPath(configured);
}

export function findVaultPath(
  pluginConfig: ClawVaultPluginConfig,
  options: { agentId?: string; cwd?: string } = {}
): string | null {
  const agentId = sanitizeAgentId(options.agentId);
  if (agentId) {
    const perAgent = resolveAgentVaultPath(pluginConfig, agentId);
    if (perAgent) return perAgent;
  }

  const configured = validateVaultPath(pluginConfig.vaultPath ?? null);
  if (configured) return configured;

  if (allowsEnvAccess(pluginConfig)) {
    const fromPluginEnv = validateVaultPath(process.env.OPENCLAW_PLUGIN_CLAWVAULT_VAULTPATH ?? null);
    if (fromPluginEnv) return fromPluginEnv;

    const fromClawVaultEnv = validateVaultPath(process.env.CLAWVAULT_PATH ?? null);
    if (fromClawVaultEnv) return fromClawVaultEnv;
  }

  let dir = path.resolve(options.cwd ?? process.cwd());
  const root = path.parse(dir).root;

  while (dir !== root) {
    const direct = validateVaultPath(dir);
    if (direct) return direct;

    const memorySubdir = validateVaultPath(path.join(dir, "memory"));
    if (memorySubdir) return memorySubdir;

    dir = path.dirname(dir);
  }

  return null;
}
