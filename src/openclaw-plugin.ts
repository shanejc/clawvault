import { createMemorySlotPlugin, registerMemorySlot } from "./plugin/slot.js";
import {
  extractAgentIdFromSessionKey,
  getPackBehaviorMode,
  getPackCallbackPolicy,
  isPackEnabled,
  readPluginConfig
} from "./plugin/config.js";
import {
  ClawVaultMemoryManager,
  createMemoryCategoriesToolFactory,
  createMemoryClassifyToolFactory,
  createMemoryGetToolFactory,
  createMemorySearchToolFactory
} from "./plugin/memory-manager.js";
import {
  createMemoryCaptureSourceToolFactory,
  createMemoryUpdateToolFactory,
  createMemoryWriteBootToolFactory,
  createMemoryWriteVaultToolFactory
} from "./plugin/memory-write-tools.js";
import { ClawVaultPluginRuntimeState } from "./plugin/runtime-state.js";
import { createBeforePromptBuildHandler } from "./plugin/hooks/before-prompt-build.js";
import { createMessageSendingHandler } from "./plugin/hooks/message-sending.js";
import {
  handleGatewayStart,
  handleSessionEnd,
  handleSessionStart,
  handleBeforeReset
} from "./plugin/hooks/session-lifecycle.js";
import {
  handleAgentEndHeartbeat,
  handleBeforeCompactionObservation,
  createAgentEndWritebackHandler
} from "./plugin/hooks/observation.js";
import type {
  ClawVaultCallbackDecision,
  ClawVaultCallbackPayload,
  ClawVaultCallbackResultMap,
  ClawVaultDistillationOrchestrationPayload,
  ClawVaultSuggestedActionMap,
  OpenClawMemoryCapabilityRegistration,
  OpenClawMemoryEmbeddingProviderAdapterRegistration,
  OpenClawMemoryEmbeddingRegistration,
  OpenClawMemoryFlushPlanResolverRegistration,
  OpenClawMemoryFlushRegistration,
  OpenClawMemoryPromptRegistration,
  OpenClawMemoryPromptSectionRegistration,
  OpenClawMemoryRuntimeRegistration,
  OpenClawPluginApi,
  PluginHookAgentContext,
  PluginHookAgentEndEvent,
  PluginHookBeforePromptBuildResult,
  PluginHookName
} from "./plugin/openclaw-types.js";
import type { ClawVaultCallbackPolicy, ClawVaultPluginConfig } from "./plugin/config.js";
import type { ClawVaultAutomationPack } from "./plugin/packs.js";

interface AutomationHookDependencies {
  pluginConfig: ClawVaultPluginConfig;
  runtimeState: ClawVaultPluginRuntimeState;
  memoryManager: ClawVaultMemoryManager;
  agentEndWritebackHandler?: (event: PluginHookAgentEndEvent, ctx: PluginHookAgentContext) => Promise<void>;
}

const AUTOMATION_PACKS: readonly ClawVaultAutomationPack[] = [
  "session-memory",
  "capture-observation",
  "reflection-maintenance",
  "legacy-communication-policy"
] as const;
const RUNTIME_STATE_BY_API = new WeakMap<OpenClawPluginApi, ClawVaultPluginRuntimeState>();
const ONBOARDING_PROMPTED_PROCESS_KEY = "__clawvaultOnboardingPromptedInProcess";
const LEGACY_AUTOMATION_CONFIG_KEYS: ReadonlyArray<keyof ClawVaultPluginConfig> = [
  "enableStartupRecovery",
  "enableSessionContextInjection",
  "enableAutoCheckpoint",
  "enableObserveOnNew",
  "enableHeartbeatObservation",
  "enableCompactionObservation",
  "enableWeeklyReflection",
  "enableFactExtraction",
  "autoCheckpoint",
  "observeOnHeartbeat",
  "weeklyReflection",
  "enableBeforePromptRecall",
  "enableStrictBeforePromptRecall",
  "enforceCommunicationProtocol",
  "enableMessageSendingFilter"
];
const DEFAULT_MEMORY_FLUSH_SOFT_TOKENS = 4000;
const DEFAULT_MEMORY_FLUSH_FORCE_TRANSCRIPT_BYTES = 2 * 1024 * 1024;
const DEFAULT_MEMORY_FLUSH_RESERVE_TOKENS_FLOOR = 20000;
const DEFAULT_MEMORY_FLUSH_PROMPT = [
  "Pre-compaction memory flush.",
  "Store durable memories only in memory/YYYY-MM-DD.md (create memory/ if needed).",
  "Treat workspace bootstrap/reference files such as MEMORY.md, SOUL.md, TOOLS.md, and AGENTS.md as read-only during this flush; never overwrite, replace, or edit them.",
  "If memory/YYYY-MM-DD.md already exists, APPEND new content only and do not overwrite existing entries.",
  "Do NOT create timestamped variant files (e.g., YYYY-MM-DD-HHMM.md); always use the canonical YYYY-MM-DD.md filename.",
  "If nothing to store, reply with NO_REPLY."
].join(" ");
const DEFAULT_MEMORY_FLUSH_SYSTEM_PROMPT = [
  "Pre-compaction memory flush turn.",
  "The session is near auto-compaction; capture durable memories to disk.",
  "Store durable memories only in memory/YYYY-MM-DD.md (create memory/ if needed).",
  "Treat workspace bootstrap/reference files such as MEMORY.md, SOUL.md, TOOLS.md, and AGENTS.md as read-only during this flush; never overwrite, replace, or edit them.",
  "If memory/YYYY-MM-DD.md already exists, APPEND new content only and do not overwrite existing entries.",
  "You may reply, but usually NO_REPLY is correct."
].join(" ");

function isOnboardingPromptedInProcess(): boolean {
  return (globalThis as Record<string, unknown>)[ONBOARDING_PROMPTED_PROCESS_KEY] === true;
}

function markOnboardingPromptedInProcess(): void {
  (globalThis as Record<string, unknown>)[ONBOARDING_PROMPTED_PROCESS_KEY] = true;
}

function hasExplicitAutomationConfig(pluginConfig: ClawVaultPluginConfig): boolean {
  if (typeof pluginConfig.automationMode === "boolean") {
    return true;
  }

  const explicitPackToggleEntries = pluginConfig.packToggles
    ? Object.values(pluginConfig.packToggles).filter((value) => typeof value === "boolean")
    : [];
  if (explicitPackToggleEntries.length > 0) {
    return true;
  }

  const explicitDomainModeEntries = pluginConfig.memoryBehaviorDomains
    ? Object.values(pluginConfig.memoryBehaviorDomains).filter((value) => value === "off" || value === "auto" || value === "callback")
    : [];
  if (explicitDomainModeEntries.length > 0) {
    return true;
  }

  if (LEGACY_AUTOMATION_CONFIG_KEYS.some((key) => typeof pluginConfig[key] === "boolean")) {
    return true;
  }

  return false;
}

function getEffectiveHookConfig(
  pluginConfig: ClawVaultPluginConfig,
  autoPacks: ClawVaultAutomationPack[]
): ClawVaultPluginConfig {
  if (autoPacks.length === 0) {
    return pluginConfig;
  }

  const forcedModes = {
    ...(pluginConfig.memoryBehaviorDomains ?? {})
  };
  for (const pack of AUTOMATION_PACKS) {
    if (!autoPacks.includes(pack)) {
      forcedModes[pack] = "off";
    }
  }

  return {
    ...pluginConfig,
    memoryBehaviorDomains: forcedModes
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getRecordField(value: unknown, key: string): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const nested = value[key];
  return isRecord(nested) ? nested : null;
}

function getStringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const raw = value[key];
  return typeof raw === "string" ? raw : undefined;
}

function getNumberField(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const raw = value[key];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

function parseNonNegativeByteSize(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  const match = /^(\d+)\s*(b|kb|mb|gb|tb)?$/i.exec(trimmed);
  if (!match?.[1]) return undefined;
  const base = Number.parseInt(match[1], 10);
  if (!Number.isFinite(base) || base < 0) return undefined;
  const suffix = (match[2] ?? "b").toLowerCase();
  const scale = suffix === "tb" ? 1024 ** 4
    : suffix === "gb" ? 1024 ** 3
      : suffix === "mb" ? 1024 ** 2
        : suffix === "kb" ? 1024
          : 1;
  return Math.floor(base * scale);
}

function formatDateStampInTimezone(nowMs: number, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(new Date(nowMs));
    const year = parts.find((part) => part.type === "year")?.value;
    const month = parts.find((part) => part.type === "month")?.value;
    const day = parts.find((part) => part.type === "day")?.value;
    if (year && month && day) return `${year}-${month}-${day}`;
  } catch {
    // fall through to UTC fallback
  }
  return new Date(nowMs).toISOString().slice(0, 10);
}

function resolveOpenClawDefaultsConfig(cfg: unknown): Record<string, unknown> | null {
  const agents = getRecordField(cfg, "agents");
  return getRecordField(agents, "defaults");
}

async function dispatchPackCallback<K extends PluginHookName>(
  api: OpenClawPluginApi,
  pluginConfig: ClawVaultPluginConfig,
  pack: ClawVaultAutomationPack,
  hookName: K,
  event: unknown,
  ctx: unknown,
  sequence: number
): Promise<ClawVaultCallbackResultMap[K]> {
  const callbackPolicy = getPackCallbackPolicy(pluginConfig, pack);
  const payload = createCallbackPayload(pack, hookName, event, ctx, sequence);
  await api.emitRuntimeEvent?.("clawvault:callback_invocation", payload);

  const invokeWithTimeout = async (callback: (callbackPayload: ClawVaultCallbackPayload) => unknown | Promise<unknown>) => {
    return withTimeout(
      Promise.resolve(callback(payload)),
      getCallbackTimeoutMs(pluginConfig)
    );
  };

  if (typeof api.invokeClawVaultCallback === "function") {
    try {
      const result = await invokeWithTimeout(api.invokeClawVaultCallback);
      const parsed = parseCallbackDecision(hookName, result, {
        logger: api.logger.warn,
        pack,
        correlationId: payload.correlationId
      });
      if (parsed) return parsed;
      return resolvePolicyFallback(hookName, callbackPolicy, {
        logger: api.logger,
        pack,
        reason: `invalid callback result (correlationId=${payload.correlationId})`
      });
    } catch (error) {
      api.logger.warn(formatCallbackFailure(pack, hookName, payload.correlationId, error));
      return resolvePolicyFallback(hookName, callbackPolicy, {
        logger: api.logger,
        pack,
        reason: `callback invocation failed (correlationId=${payload.correlationId})`
      });
    }
  }

  const callback = pluginConfig.memoryBehaviorCallbacks?.[pack];
  if (typeof callback !== "function") {
    return resolvePolicyFallback(hookName, callbackPolicy, {
      logger: api.logger,
      pack,
      reason: "no callback handler configured"
    });
  }
  try {
    const result = await invokeWithTimeout(callback);
    const parsed = parseCallbackDecision(hookName, result, {
      logger: api.logger.warn,
      pack,
      correlationId: payload.correlationId
    });
    if (parsed) return parsed;
    return resolvePolicyFallback(hookName, callbackPolicy, {
      logger: api.logger,
      pack,
      reason: `invalid callback result (correlationId=${payload.correlationId})`
    });
  } catch (error) {
    api.logger.warn(formatCallbackFailure(pack, hookName, payload.correlationId, error));
    return resolvePolicyFallback(hookName, callbackPolicy, {
      logger: api.logger,
      pack,
      reason: `callback invocation failed (correlationId=${payload.correlationId})`
    });
  }
}

function createCallbackPayload<K extends PluginHookName>(
  pack: ClawVaultAutomationPack,
  hookName: K,
  event: unknown,
  ctx: unknown,
  sequence: number
): ClawVaultCallbackPayload {
  const suggestedActions = getSuggestedActions(hookName);
  return {
    domain: pack,
    trigger: hookName,
    context: {
      event,
      hookContext: ctx
    },
    suggestedActions,
    correlationId: `clawvault:${pack}:${hookName}:${sequence}`
  };
}

function getSuggestedActions<K extends PluginHookName>(hookName: K): ClawVaultSuggestedActionMap[K] {
  if (hookName === "before_prompt_build") {
    return ["prepend_context", "append_context", "prepend_system_context", "append_system_context", "rewrite_system_prompt"] as ClawVaultSuggestedActionMap[K];
  }
  if (hookName === "message_sending") {
    return ["rewrite_message", "cancel_message"] as ClawVaultSuggestedActionMap[K];
  }
  return ["observe_lifecycle", "trigger_lifecycle_action"] as ClawVaultSuggestedActionMap[K];
}

function getCallbackTimeoutMs(pluginConfig: ClawVaultPluginConfig): number {
  const configured = pluginConfig.memoryBehaviorCallbackTimeoutMs;
  if (typeof configured !== "number" || !Number.isFinite(configured)) {
    return 1500;
  }
  return Math.max(50, Math.floor(configured));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`callback_timeout_${timeoutMs}ms`));
    }, timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function formatCallbackFailure(
  pack: ClawVaultAutomationPack,
  hookName: PluginHookName,
  correlationId: string,
  error: unknown
): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `[clawvault] callback invocation failed (${pack}:${hookName}, correlationId=${correlationId}): ${detail}`;
}

function getCallbackFallback(hookName: PluginHookName): ClawVaultCallbackResultMap[PluginHookName] {
  if (hookName === "message_sending") {
    return { decision: "handled", cancel: false };
  }
  return { decision: "skip" };
}

function getSkipFallback(): { decision: "skip" } {
  return { decision: "skip" };
}

function resolvePolicyFallback<K extends PluginHookName>(
  hookName: K,
  policy: ClawVaultCallbackPolicy,
  details: { logger: Pick<OpenClawPluginApi["logger"], "warn" | "error">; pack: ClawVaultAutomationPack; reason: string }
): ClawVaultCallbackResultMap[K] {
  if (policy === "hardFail") {
    const message = `[clawvault] callback policy hardFail triggered (${details.pack}:${hookName}): ${details.reason}`;
    details.logger.error(message);
    throw new Error(message);
  }
  if (policy === "fallbackToAuto") {
    details.logger.warn(`[clawvault] callback policy fallbackToAuto applied (${details.pack}:${hookName}): ${details.reason}`);
    return { decision: "fallback_auto" } as ClawVaultCallbackResultMap[K];
  }
  if (policy === "skip") {
    details.logger.warn(`[clawvault] callback policy skip applied (${details.pack}:${hookName}): ${details.reason}`);
    return getSkipFallback() as ClawVaultCallbackResultMap[K];
  }
  return getCallbackFallback(hookName) as ClawVaultCallbackResultMap[K];
}

function parseDecision(value: unknown): ClawVaultCallbackDecision | null {
  if (value === "handled" || value === "skip" || value === "fallback_auto" || value === "error") {
    return value;
  }
  return null;
}

function parseCallbackDecision<K extends PluginHookName>(
  hookName: K,
  value: unknown,
  details: { logger: (message: string) => void; pack: ClawVaultAutomationPack; correlationId: string }
): ClawVaultCallbackResultMap[K] | null {
  if (!isRecord(value)) {
    details.logger(
      `[clawvault] invalid callback result shape (${details.pack}:${hookName}, correlationId=${details.correlationId}): expected object`
    );
    return null;
  }

  const decision = parseDecision(value.decision);
  if (!decision) {
    details.logger(
      `[clawvault] invalid callback decision (${details.pack}:${hookName}, correlationId=${details.correlationId}): ${String(value.decision)}`
    );
    return null;
  }
  logUnsupportedCallbackFields(hookName, value, details);

  if (hookName === "before_prompt_build") {
    if (decision !== "handled") {
      return { decision } as ClawVaultCallbackResultMap[K];
    }

    return {
      decision,
      prependSystemContext: getOptionalStringField(value, "prependSystemContext", details, hookName),
      appendSystemContext: getOptionalStringField(value, "appendSystemContext", details, hookName),
      prependContext: getOptionalStringField(value, "prependContext", details, hookName),
      systemPrompt: getOptionalStringField(value, "systemPrompt", details, hookName)
    } as ClawVaultCallbackResultMap[K];
  }

  if (hookName === "message_sending") {
    if (decision !== "handled") {
      return { decision } as ClawVaultCallbackResultMap[K];
    }

    return {
      decision,
      content: getOptionalStringField(value, "content", details, hookName),
      cancel: getOptionalBooleanField(value, "cancel", details, hookName)
    } as ClawVaultCallbackResultMap[K];
  }

  if (decision !== "handled") {
    return { decision } as ClawVaultCallbackResultMap[K];
  }

  return {
    decision,
    observe: getOptionalBooleanField(value, "observe", details, hookName),
    triggerLifecycleAction: getOptionalBooleanField(value, "triggerLifecycleAction", details, hookName),
    distillationOutcome: getOptionalDistillationOutcomeField(value, "distillationOutcome", details, hookName),
    note: getOptionalStringField(value, "note", details, hookName)
  } as ClawVaultCallbackResultMap[K];
}

function getOptionalStringField<K extends PluginHookName>(
  source: Record<string, unknown>,
  fieldName: string,
  details: { logger: (message: string) => void; pack: ClawVaultAutomationPack; correlationId: string },
  hookName: K
): string | undefined {
  const value = source[fieldName];
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  details.logger(
    `[clawvault] unsupported callback field value ${fieldName} (${details.pack}:${hookName}, correlationId=${details.correlationId}); ignoring`
  );
  return undefined;
}

function getOptionalBooleanField<K extends PluginHookName>(
  source: Record<string, unknown>,
  fieldName: string,
  details: { logger: (message: string) => void; pack: ClawVaultAutomationPack; correlationId: string },
  hookName: K
): boolean | undefined {
  const value = source[fieldName];
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  details.logger(
    `[clawvault] unsupported callback field value ${fieldName} (${details.pack}:${hookName}, correlationId=${details.correlationId}); ignoring`
  );
  return undefined;
}

function getOptionalDistillationOutcomeField<K extends PluginHookName>(
  source: Record<string, unknown>,
  fieldName: string,
  details: { logger: (message: string) => void; pack: ClawVaultAutomationPack; correlationId: string },
  hookName: K
): "local_run_approved" | "delegated_event" | "queued_for_approval" | "skipped" | undefined {
  const value = source[fieldName];
  if (value === undefined) return undefined;
  if (
    value === "local_run_approved"
    || value === "delegated_event"
    || value === "queued_for_approval"
    || value === "skipped"
  ) {
    return value;
  }
  details.logger(
    `[clawvault] unsupported callback field value ${fieldName} (${details.pack}:${hookName}, correlationId=${details.correlationId}); ignoring`
  );
  return undefined;
}

const ALLOWED_CALLBACK_RESULT_FIELDS: { [K in PluginHookName]: readonly string[] } = {
  before_prompt_build: ["decision", "reason", "prependSystemContext", "appendSystemContext", "prependContext", "systemPrompt"],
  message_sending: ["decision", "reason", "content", "cancel"],
  session_start: ["decision", "reason", "observe", "triggerLifecycleAction", "distillationOutcome", "note"],
  session_end: ["decision", "reason", "observe", "triggerLifecycleAction", "distillationOutcome", "note"],
  gateway_start: ["decision", "reason", "observe", "triggerLifecycleAction", "distillationOutcome", "note"],
  before_reset: ["decision", "reason", "observe", "triggerLifecycleAction", "distillationOutcome", "note"],
  before_compaction: ["decision", "reason", "observe", "triggerLifecycleAction", "distillationOutcome", "note"],
  agent_end: ["decision", "reason", "observe", "triggerLifecycleAction", "distillationOutcome", "note"]
};

function logUnsupportedCallbackFields<K extends PluginHookName>(
  hookName: K,
  result: Record<string, unknown>,
  details: { logger: (message: string) => void; pack: ClawVaultAutomationPack; correlationId: string }
): void {
  const allowedFields = new Set(ALLOWED_CALLBACK_RESULT_FIELDS[hookName]);
  for (const field of Object.keys(result)) {
    if (allowedFields.has(field)) {
      continue;
    }
    details.logger(
      `[clawvault] unsupported callback field ${field} (${details.pack}:${hookName}, correlationId=${details.correlationId}); ignoring`
    );
  }
}

function applyNonHandledDecisionPolicy(
  decision: ClawVaultCallbackDecision,
  hookName: PluginHookName,
  policy: ClawVaultCallbackPolicy,
  details: { logger: Pick<OpenClawPluginApi["logger"], "warn" | "error">; pack: ClawVaultAutomationPack }
): ClawVaultCallbackDecision {
  if (decision === "handled") return decision;
  if (policy === "legacy") return decision;
  if (policy === "hardFail") {
    const message = `[clawvault] callback policy hardFail triggered (${details.pack}:${hookName}): callback returned non-handled decision ${decision}`;
    details.logger.error(message);
    throw new Error(message);
  }
  if (policy === "fallbackToAuto") {
    details.logger.warn(`[clawvault] callback policy fallbackToAuto applied (${details.pack}:${hookName}): callback returned ${decision}`);
    return "fallback_auto";
  }
  details.logger.warn(`[clawvault] callback policy skip applied (${details.pack}:${hookName}): callback returned ${decision}`);
  return "skip";
}

function mergeBeforePromptBuildResults(results: Array<PluginHookBeforePromptBuildResult | void>): PluginHookBeforePromptBuildResult | void {
  const prependSections: string[] = [];
  const appendSections: string[] = [];

  for (const result of results) {
    if (!result || typeof result !== "object") continue;
    const candidate = result as { prependSystemContext?: unknown; appendSystemContext?: unknown };
    if (typeof candidate.prependSystemContext === "string" && candidate.prependSystemContext.trim()) {
      prependSections.push(candidate.prependSystemContext.trim());
    }
    if (typeof candidate.appendSystemContext === "string" && candidate.appendSystemContext.trim()) {
      appendSections.push(candidate.appendSystemContext.trim());
    }
  }

  if (prependSections.length === 0 && appendSections.length === 0) {
    return;
  }

  const prepend = prependSections.join("\n\n");
  const append = appendSections.join("\n\n");
  return {
    prependSystemContext: prepend || undefined,
    appendSystemContext: append || undefined
  };
}

function isAutomationModeEnabled(pluginConfig: ClawVaultPluginConfig): boolean {
  return AUTOMATION_PACKS.some((pack) => isPackEnabled(pluginConfig, pack));
}

async function maybeEmitOnboardingRequiredPrompt(
  api: OpenClawPluginApi,
  pluginConfig: ClawVaultPluginConfig,
  runtimeState: ClawVaultPluginRuntimeState
): Promise<void> {
  if (pluginConfig.packPreset || pluginConfig.automationPreset) {
    return;
  }
  if (hasExplicitAutomationConfig(pluginConfig)) {
    return;
  }
  if (isOnboardingPromptedInProcess()) {
    runtimeState.markOnboardingPrompted();
    return;
  }
  if (!runtimeState.shouldPromptOnboarding()) {
    return;
  }

  runtimeState.markOnboardingPrompted();
  markOnboardingPromptedInProcess();
  api.logger.info(
    "[clawvault] OpenClaw preset is unset (packPreset/automationPreset). Run `clawvault openclaw onboard` to complete first-run setup."
  );
  await api.emitRuntimeEvent?.("clawvault:onboarding_required", {
    reason: "missing_pack_preset",
    configPaths: ["packPreset", "automationPreset"],
    command: "clawvault openclaw onboard"
  });
}

function registerAutomationHooks(api: OpenClawPluginApi, deps: AutomationHookDependencies): void {
  const { pluginConfig, runtimeState, memoryManager } = deps;
  const sessionMemoryMode = getPackBehaviorMode(pluginConfig, "session-memory");
  const captureObservationMode = getPackBehaviorMode(pluginConfig, "capture-observation");
  const reflectionMaintenanceMode = getPackBehaviorMode(pluginConfig, "reflection-maintenance");
  const communicationPolicyMode = getPackBehaviorMode(pluginConfig, "legacy-communication-policy");
  const sessionMemoryCallbackPolicy = getPackCallbackPolicy(pluginConfig, "session-memory");
  const captureObservationCallbackPolicy = getPackCallbackPolicy(pluginConfig, "capture-observation");
  const reflectionMaintenanceCallbackPolicy = getPackCallbackPolicy(pluginConfig, "reflection-maintenance");
  const communicationPolicyCallbackPolicy = getPackCallbackPolicy(pluginConfig, "legacy-communication-policy");
  const sessionMemoryEnabled = sessionMemoryMode !== "off";
  const captureObservationEnabled = captureObservationMode !== "off";
  const reflectionMaintenanceEnabled = reflectionMaintenanceMode !== "off";
  const communicationPolicyEnabled = communicationPolicyMode !== "off";
  const beforePromptAutoPacks = AUTOMATION_PACKS.filter((pack) => {
    if (pack === "session-memory") return sessionMemoryMode === "auto";
    if (pack === "legacy-communication-policy") return communicationPolicyMode === "auto";
    return false;
  });
  const lifecycleAutoPacks = AUTOMATION_PACKS.filter((pack) => {
    if (pack === "session-memory") return sessionMemoryMode === "auto";
    if (pack === "capture-observation") return captureObservationMode === "auto";
    if (pack === "reflection-maintenance") return reflectionMaintenanceMode === "auto";
    return false;
  });
  const captureAutoPacks = AUTOMATION_PACKS.filter((pack) => {
    if (pack === "capture-observation") return captureObservationMode === "auto";
    return false;
  });
  let callbackSequence = 0;
  const nextSequence = () => {
    callbackSequence += 1;
    return callbackSequence;
  };

  if (sessionMemoryEnabled || communicationPolicyEnabled) {
    const builtInBeforePromptBuildHandler = createBeforePromptBuildHandler({
      pluginConfig: getEffectiveHookConfig(pluginConfig, beforePromptAutoPacks),
      runtimeState
    });
    api.on("before_prompt_build", async (event, ctx) => {
      const results: Array<PluginHookBeforePromptBuildResult | void> = [];
      if (beforePromptAutoPacks.length > 0) {
        results.push(await builtInBeforePromptBuildHandler(event, ctx));
      }
      if (sessionMemoryMode === "callback") {
        const callback = await dispatchPackCallback(api, pluginConfig, "session-memory", "before_prompt_build", event, ctx, nextSequence());
        const decision = applyNonHandledDecisionPolicy(callback.decision, "before_prompt_build", sessionMemoryCallbackPolicy, {
          logger: api.logger,
          pack: "session-memory"
        });
        if (decision === "handled") {
          results.push(callback);
        } else if (decision === "fallback_auto") {
          results.push(await builtInBeforePromptBuildHandler(event, ctx));
        } else if (decision === "error") {
          api.logger.warn("[clawvault] before_prompt_build callback returned error decision; skipping callback output");
        }
      }
      if (communicationPolicyMode === "callback") {
        const callback = await dispatchPackCallback(
          api,
          pluginConfig,
          "legacy-communication-policy",
          "before_prompt_build",
          event,
          ctx,
          nextSequence()
        );
        const decision = applyNonHandledDecisionPolicy(callback.decision, "before_prompt_build", communicationPolicyCallbackPolicy, {
          logger: api.logger,
          pack: "legacy-communication-policy"
        });
        if (decision === "handled") {
          results.push(callback);
        } else if (decision === "fallback_auto") {
          results.push(await builtInBeforePromptBuildHandler(event, ctx));
        } else if (decision === "error") {
          api.logger.warn("[clawvault] before_prompt_build callback returned error decision; skipping callback output");
        }
      }
      return mergeBeforePromptBuildResults(results);
    }, { priority: 30 });
  }

  if (communicationPolicyEnabled) {
    const communicationAutoConfig = getEffectiveHookConfig(
      pluginConfig,
      communicationPolicyMode === "auto" ? ["legacy-communication-policy"] : []
    );
    const builtInMessageHandler = createMessageSendingHandler({
      pluginConfig: communicationAutoConfig,
      memoryManager
    });
    api.on("message_sending", async (event, ctx) => {
      if (communicationPolicyMode === "auto") {
        return builtInMessageHandler(event, ctx);
      }
      const callback = await dispatchPackCallback(
        api,
        pluginConfig,
        "legacy-communication-policy",
        "message_sending",
        event,
        ctx,
        nextSequence()
      );
      const decision = applyNonHandledDecisionPolicy(callback.decision, "message_sending", communicationPolicyCallbackPolicy, {
        logger: api.logger,
        pack: "legacy-communication-policy"
      });
      if (decision === "handled") {
        return {
          content: callback.content,
          cancel: callback.cancel
        };
      }
      if (decision === "fallback_auto") {
        return builtInMessageHandler(event, ctx);
      }
      if (decision === "error") {
        api.logger.warn("[clawvault] message_sending callback returned error decision; using safe fallback");
        return { cancel: false };
      }
      return;
    }, { priority: 20 });
  }

  if (sessionMemoryEnabled || captureObservationEnabled || reflectionMaintenanceEnabled) {
    const lifecycleConfig = getEffectiveHookConfig(pluginConfig, lifecycleAutoPacks);
    const emitDistillationOrchestrationEvent = async (
      payload: ClawVaultDistillationOrchestrationPayload
    ): Promise<void> => {
      await api.emitRuntimeEvent?.("clawvault:distillation_orchestration", payload);
    };

    const runLifecycleAutoFallback = async (hookName: "gateway_start" | "session_start" | "session_end" | "before_reset", event: unknown, ctx: unknown) => {
      if (hookName === "gateway_start") {
        await handleGatewayStart(event as never, ctx as never, {
          pluginConfig: lifecycleConfig,
          runtimeState,
          logger: api.logger
        });
      } else if (hookName === "session_start") {
        await handleSessionStart(event as never, ctx as never, {
          pluginConfig: lifecycleConfig,
          runtimeState,
          logger: api.logger
        });
      } else if (hookName === "session_end") {
        await handleSessionEnd(event as never, ctx as never, {
          pluginConfig: lifecycleConfig,
          runtimeState,
          logger: api.logger
        });
      } else {
        await handleBeforeReset(event as never, ctx as never, {
          pluginConfig: lifecycleConfig,
          runtimeState,
          logger: api.logger
        });
      }
    };

    const applyLifecycleCallbackDecision = async (
      decision: ClawVaultCallbackDecision,
      hookName: "gateway_start" | "session_start" | "session_end" | "before_reset",
      event: unknown,
      ctx: unknown
    ) => {
      if (decision === "fallback_auto") {
        await runLifecycleAutoFallback(hookName, event, ctx);
      } else if (decision === "error") {
        api.logger.warn(`[clawvault] ${hookName} callback returned error decision; continuing safely`);
      }
    };

    const applyReflectionDistillationOrchestration = async (
      hookName: "gateway_start" | "session_start" | "session_end" | "before_reset",
      callback: ClawVaultCallbackResultMap["session_start"],
      correlationId: string,
      event: unknown,
      ctx: unknown
    ) => {
      const outcome = callback.distillationOutcome ?? "skipped";
      if (outcome === "local_run_approved") {
        await runLifecycleAutoFallback(hookName, event, ctx);
        await emitDistillationOrchestrationEvent({
          domain: "reflection-maintenance",
          trigger: hookName,
          correlationId,
          outcome,
          note: callback.note
        });
        return;
      }

      await emitDistillationOrchestrationEvent({
        domain: "reflection-maintenance",
        trigger: hookName,
        correlationId,
        outcome,
        note: callback.note
      });

      if (outcome === "delegated_event") {
        api.logger.info(`[clawvault] reflection-maintenance delegated distillation (${hookName}, correlationId=${correlationId})`);
      } else if (outcome === "queued_for_approval") {
        api.logger.info(`[clawvault] reflection-maintenance queued distillation for approval (${hookName}, correlationId=${correlationId})`);
      } else {
        api.logger.info(`[clawvault] reflection-maintenance distillation skipped (${hookName}, correlationId=${correlationId})`);
      }
    };

    api.on("gateway_start", async (event, ctx) => {
      if (lifecycleAutoPacks.length > 0) {
        await handleGatewayStart(event, ctx, {
          pluginConfig: lifecycleConfig,
          runtimeState,
          logger: api.logger
        });
      }
      if (sessionMemoryMode === "callback") {
        const callback = await dispatchPackCallback(api, pluginConfig, "session-memory", "gateway_start", event, ctx, nextSequence());
        const decision = applyNonHandledDecisionPolicy(callback.decision, "gateway_start", sessionMemoryCallbackPolicy, {
          logger: api.logger,
          pack: "session-memory"
        });
        await applyLifecycleCallbackDecision(decision, "gateway_start", event, ctx);
      }
      if (captureObservationMode === "callback") {
        const callback = await dispatchPackCallback(api, pluginConfig, "capture-observation", "gateway_start", event, ctx, nextSequence());
        const decision = applyNonHandledDecisionPolicy(callback.decision, "gateway_start", captureObservationCallbackPolicy, {
          logger: api.logger,
          pack: "capture-observation"
        });
        await applyLifecycleCallbackDecision(decision, "gateway_start", event, ctx);
      }
      if (reflectionMaintenanceMode === "callback") {
        const sequence = nextSequence();
        const callback = await dispatchPackCallback(api, pluginConfig, "reflection-maintenance", "gateway_start", event, ctx, sequence);
        const decision = applyNonHandledDecisionPolicy(callback.decision, "gateway_start", reflectionMaintenanceCallbackPolicy, {
          logger: api.logger,
          pack: "reflection-maintenance"
        });
        if (decision === "handled") {
          await applyReflectionDistillationOrchestration("gateway_start", callback, `clawvault:reflection-maintenance:gateway_start:${sequence}`, event, ctx);
        } else {
          await applyLifecycleCallbackDecision(decision, "gateway_start", event, ctx);
        }
      }
    });

    api.on("session_start", async (event, ctx) => {
      if (lifecycleAutoPacks.length > 0) {
        await handleSessionStart(event, ctx, {
          pluginConfig: lifecycleConfig,
          runtimeState,
          logger: api.logger
        });
      }
      if (sessionMemoryMode === "callback") {
        const callback = await dispatchPackCallback(api, pluginConfig, "session-memory", "session_start", event, ctx, nextSequence());
        const decision = applyNonHandledDecisionPolicy(callback.decision, "session_start", sessionMemoryCallbackPolicy, {
          logger: api.logger,
          pack: "session-memory"
        });
        await applyLifecycleCallbackDecision(decision, "session_start", event, ctx);
      }
      if (captureObservationMode === "callback") {
        const callback = await dispatchPackCallback(api, pluginConfig, "capture-observation", "session_start", event, ctx, nextSequence());
        const decision = applyNonHandledDecisionPolicy(callback.decision, "session_start", captureObservationCallbackPolicy, {
          logger: api.logger,
          pack: "capture-observation"
        });
        await applyLifecycleCallbackDecision(decision, "session_start", event, ctx);
      }
      if (reflectionMaintenanceMode === "callback") {
        const sequence = nextSequence();
        const callback = await dispatchPackCallback(api, pluginConfig, "reflection-maintenance", "session_start", event, ctx, sequence);
        const decision = applyNonHandledDecisionPolicy(callback.decision, "session_start", reflectionMaintenanceCallbackPolicy, {
          logger: api.logger,
          pack: "reflection-maintenance"
        });
        if (decision === "handled") {
          await applyReflectionDistillationOrchestration("session_start", callback, `clawvault:reflection-maintenance:session_start:${sequence}`, event, ctx);
        } else {
          await applyLifecycleCallbackDecision(decision, "session_start", event, ctx);
        }
      }
    });

    api.on("session_end", async (event, ctx) => {
      if (lifecycleAutoPacks.length > 0) {
        await handleSessionEnd(event, ctx, {
          pluginConfig: lifecycleConfig,
          runtimeState,
          logger: api.logger
        });
      }
      if (sessionMemoryMode === "callback") {
        const callback = await dispatchPackCallback(api, pluginConfig, "session-memory", "session_end", event, ctx, nextSequence());
        const decision = applyNonHandledDecisionPolicy(callback.decision, "session_end", sessionMemoryCallbackPolicy, {
          logger: api.logger,
          pack: "session-memory"
        });
        await applyLifecycleCallbackDecision(decision, "session_end", event, ctx);
      }
      if (captureObservationMode === "callback") {
        const callback = await dispatchPackCallback(api, pluginConfig, "capture-observation", "session_end", event, ctx, nextSequence());
        const decision = applyNonHandledDecisionPolicy(callback.decision, "session_end", captureObservationCallbackPolicy, {
          logger: api.logger,
          pack: "capture-observation"
        });
        await applyLifecycleCallbackDecision(decision, "session_end", event, ctx);
      }
      if (reflectionMaintenanceMode === "callback") {
        const sequence = nextSequence();
        const callback = await dispatchPackCallback(api, pluginConfig, "reflection-maintenance", "session_end", event, ctx, sequence);
        const decision = applyNonHandledDecisionPolicy(callback.decision, "session_end", reflectionMaintenanceCallbackPolicy, {
          logger: api.logger,
          pack: "reflection-maintenance"
        });
        if (decision === "handled") {
          await applyReflectionDistillationOrchestration("session_end", callback, `clawvault:reflection-maintenance:session_end:${sequence}`, event, ctx);
        } else {
          await applyLifecycleCallbackDecision(decision, "session_end", event, ctx);
        }
      }
    });

    api.on("before_reset", async (event, ctx) => {
      if (lifecycleAutoPacks.length > 0) {
        await handleBeforeReset(event, ctx, {
          pluginConfig: lifecycleConfig,
          runtimeState,
          logger: api.logger
        });
      }
      if (sessionMemoryMode === "callback") {
        const callback = await dispatchPackCallback(api, pluginConfig, "session-memory", "before_reset", event, ctx, nextSequence());
        const decision = applyNonHandledDecisionPolicy(callback.decision, "before_reset", sessionMemoryCallbackPolicy, {
          logger: api.logger,
          pack: "session-memory"
        });
        await applyLifecycleCallbackDecision(decision, "before_reset", event, ctx);
      }
      if (captureObservationMode === "callback") {
        const callback = await dispatchPackCallback(api, pluginConfig, "capture-observation", "before_reset", event, ctx, nextSequence());
        const decision = applyNonHandledDecisionPolicy(callback.decision, "before_reset", captureObservationCallbackPolicy, {
          logger: api.logger,
          pack: "capture-observation"
        });
        await applyLifecycleCallbackDecision(decision, "before_reset", event, ctx);
      }
      if (reflectionMaintenanceMode === "callback") {
        const sequence = nextSequence();
        const callback = await dispatchPackCallback(api, pluginConfig, "reflection-maintenance", "before_reset", event, ctx, sequence);
        const decision = applyNonHandledDecisionPolicy(callback.decision, "before_reset", reflectionMaintenanceCallbackPolicy, {
          logger: api.logger,
          pack: "reflection-maintenance"
        });
        if (decision === "handled") {
          await applyReflectionDistillationOrchestration("before_reset", callback, `clawvault:reflection-maintenance:before_reset:${sequence}`, event, ctx);
        } else {
          await applyLifecycleCallbackDecision(decision, "before_reset", event, ctx);
        }
      }
    });
  }

  if (captureObservationEnabled) {
    const observationConfig = getEffectiveHookConfig(pluginConfig, captureAutoPacks);
    api.on("before_compaction", async (event, ctx) => {
      if (captureAutoPacks.length > 0) {
        await handleBeforeCompactionObservation(event, ctx, {
          pluginConfig: observationConfig,
          logger: api.logger
        });
      }
      if (captureObservationMode === "callback") {
        const callback = await dispatchPackCallback(api, pluginConfig, "capture-observation", "before_compaction", event, ctx, nextSequence());
        const decision = applyNonHandledDecisionPolicy(callback.decision, "before_compaction", captureObservationCallbackPolicy, {
          logger: api.logger,
          pack: "capture-observation"
        });
        if (decision === "fallback_auto") {
          await handleBeforeCompactionObservation(event, ctx, {
            pluginConfig: observationConfig,
            logger: api.logger
          });
        } else if (decision === "error") {
          api.logger.warn("[clawvault] before_compaction callback returned error decision; continuing safely");
        }
      }
    });

    api.on("agent_end", async (event, ctx) => {
      if (captureAutoPacks.length > 0) {
        await handleAgentEndHeartbeat(event, ctx, {
          pluginConfig: observationConfig,
          logger: api.logger
        });
      }
      if (captureObservationMode === "callback") {
        const callback = await dispatchPackCallback(api, pluginConfig, "capture-observation", "agent_end", event, ctx, nextSequence());
        const decision = applyNonHandledDecisionPolicy(callback.decision, "agent_end", captureObservationCallbackPolicy, {
          logger: api.logger,
          pack: "capture-observation"
        });
        if (decision === "fallback_auto") {
          await handleAgentEndHeartbeat(event, ctx, {
            pluginConfig: observationConfig,
            logger: api.logger
          });
        } else if (decision === "error") {
          api.logger.warn("[clawvault] agent_end callback returned error decision; continuing safely");
        }
      }
      await deps.agentEndWritebackHandler?.(event, ctx);
    });
  }
}

function isOpenClawPluginApi(value: unknown): value is OpenClawPluginApi {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.on === "function"
    && typeof record.registerTool === "function"
    && typeof record.logger === "object";
}

function createMemoryRuntimeRegistration(
  memoryManager: ClawVaultMemoryManager,
  pluginConfig: ClawVaultPluginConfig
): OpenClawMemoryRuntimeRegistration {
  const memoryManagersByScope = new Map<string, ClawVaultMemoryManager>();
  const managerKeyFor = (params?: { sessionKey?: string; agentId?: string; workspaceDir?: string }) => {
    const sessionKey = typeof params?.sessionKey === "string" ? params.sessionKey : "";
    const derivedAgentId = extractAgentIdFromSessionKey(sessionKey);
    const agentId = params?.agentId ?? derivedAgentId ?? "main";
    const workspaceDir = typeof params?.workspaceDir === "string" ? params.workspaceDir : "";
    return `${agentId}::${workspaceDir}`;
  };

  const getOrCreateScopedManager = (params?: { sessionKey?: string; agentId?: string; workspaceDir?: string }) => {
    const key = managerKeyFor(params);
    const existing = memoryManagersByScope.get(key);
    if (existing) return existing;

    const sessionKey = typeof params?.sessionKey === "string" ? params.sessionKey : "";
    const derivedAgentId = extractAgentIdFromSessionKey(sessionKey);
    const agentId = params?.agentId ?? derivedAgentId ?? "main";
    const scopedManager = new ClawVaultMemoryManager({
      pluginConfig,
      defaultAgentId: agentId,
      workspaceDir: typeof params?.workspaceDir === "string" ? params.workspaceDir : undefined
    });
    memoryManagersByScope.set(key, scopedManager);
    return scopedManager;
  };

  return {
    async getMemorySearchManager(params) {
      const scoped = getOrCreateScopedManager({
        agentId: params?.agentId,
        workspaceDir: undefined
      });
      return { manager: scoped };
    },
    resolveMemoryBackendConfig: (params) => {
      const providerStatus = memoryManager.status();
      if (providerStatus.backend === "qmd") {
        const defaults = resolveOpenClawDefaultsConfig(params?.cfg);
        const memorySearch = getRecordField(defaults, "memorySearch");
        const qmd = getRecordField(memorySearch, "qmd");
        return {
          backend: "qmd" as const,
          qmd: {
            command: getStringField(qmd, "command")
          }
        };
      }
      return {
        backend: "builtin" as const
      };
    },
    closeAllMemorySearchManagers: async () => {
      const scopedManagers = [...memoryManagersByScope.values()];
      memoryManagersByScope.clear();
      await Promise.all(scopedManagers.map(async (manager) => manager.close()));
      await memoryManager.close();
    }
  };
}

function createMemoryPromptRegistration(): OpenClawMemoryPromptSectionRegistration {
  return (params) => {
    const lines: string[] = [];
    if (params.availableTools instanceof Set && params.availableTools.size > 0) {
      lines.push(`[ClawVault] Available memory tools: ${[...params.availableTools].join(", ")}`);
    }
    if (typeof params.citationsMode === "string" && params.citationsMode.trim().length > 0) {
      lines.push(`[ClawVault] Citations mode: ${params.citationsMode.trim()}`);
    }
    return lines;
  };
}

async function buildLegacyPromptSection(
  memoryManager: ClawVaultMemoryManager,
  params: {
    query: string;
    sessionKey?: string;
    maxResults?: number;
    minScore?: number;
  }
): Promise<{ text: string }> {
  const query = typeof params.query === "string" ? params.query.trim() : "";
  if (!query) return { text: "" };

  const results = await memoryManager.search(query, {
    sessionKey: params.sessionKey,
    maxResults: params.maxResults,
    minScore: params.minScore
  });
  if (!results.length) return { text: "" };

  const lines = results.slice(0, 5).map((result, index) => {
    const snippet = typeof result.snippet === "string" ? result.snippet : "";
    const truncated = snippet.length > 280 ? `${snippet.slice(0, 277)}...` : snippet;
    return `${index + 1}. ${truncated}`;
  });
  return { text: `ClawVault memory matches:\n${lines.join("\n")}` };
}

function createMemoryFlushPlanResolver(): OpenClawMemoryFlushPlanResolverRegistration {
  return ({ cfg, nowMs } = {}) => {
    const defaults = resolveOpenClawDefaultsConfig(cfg);
    const compaction = getRecordField(defaults, "compaction");
    const memoryFlush = getRecordField(compaction, "memoryFlush");

    if (memoryFlush?.enabled === false) {
      return null;
    }

    const resolvedNowMs = typeof nowMs === "number" && Number.isFinite(nowMs) ? nowMs : Date.now();
    const timezone = getStringField(cfg, "timezone") ?? "UTC";
    const dateStamp = formatDateStampInTimezone(resolvedNowMs, timezone);

    const softThresholdTokens = Math.max(0, Math.floor(
      getNumberField(memoryFlush, "softThresholdTokens") ?? DEFAULT_MEMORY_FLUSH_SOFT_TOKENS
    ));
    const reserveTokensFloor = Math.max(0, Math.floor(
      getNumberField(compaction, "reserveTokensFloor") ?? DEFAULT_MEMORY_FLUSH_RESERVE_TOKENS_FLOOR
    ));
    const forceFlushTranscriptBytes = parseNonNegativeByteSize(memoryFlush?.forceFlushTranscriptBytes)
      ?? DEFAULT_MEMORY_FLUSH_FORCE_TRANSCRIPT_BYTES;
    const promptTemplate = getStringField(memoryFlush, "prompt") ?? DEFAULT_MEMORY_FLUSH_PROMPT;
    const systemPromptTemplate = getStringField(memoryFlush, "systemPrompt") ?? DEFAULT_MEMORY_FLUSH_SYSTEM_PROMPT;

    return {
      softThresholdTokens,
      forceFlushTranscriptBytes,
      reserveTokensFloor,
      prompt: promptTemplate.replaceAll("YYYY-MM-DD", dateStamp),
      systemPrompt: systemPromptTemplate.replaceAll("YYYY-MM-DD", dateStamp),
      relativePath: `memory/${dateStamp}.md`
    };
  };
}

function createMemoryEmbeddingRegistration(memoryManager: ClawVaultMemoryManager): OpenClawMemoryEmbeddingProviderAdapterRegistration {
  return {
    id: "clawvault",
    probeAvailability: () => memoryManager.probeEmbeddingAvailability(),
    isVectorAvailable: () => memoryManager.probeVectorAvailability()
  };
}

function createLegacyMemoryFlushRegistration(memoryManager: ClawVaultMemoryManager): OpenClawMemoryFlushRegistration {
  return {
    async buildFlushPlan(params) {
      const reason = typeof params?.reason === "string" && params.reason.trim().length > 0
        ? params.reason.trim()
        : "memory_runtime";
      const force = params?.force === true;
      const shouldFlush = force || reason.length > 0;
      if (shouldFlush) {
        await memoryManager.sync({
          reason,
          force
        });
      }
      return {
        shouldFlush,
        note: `sync:${reason}`
      };
    }
  };
}

function createLegacyMemoryFlushPlanRegistration(): (params?: { reason?: string; force?: boolean }) => { shouldFlush: boolean; note?: string } {
  return (params) => {
    const reason = typeof params?.reason === "string" && params.reason.trim().length > 0
      ? params.reason.trim()
      : "memory_runtime";
    const force = params?.force === true;
    return {
      shouldFlush: force || reason.length > 0,
      note: `sync:${reason}`
    };
  };
}

function registerMemoryContractSurface(
  api: OpenClawPluginApi,
  memoryManager: ClawVaultMemoryManager,
  pluginConfig: ClawVaultPluginConfig
): boolean {
  const runtime = createMemoryRuntimeRegistration(memoryManager, pluginConfig);
  const prompt = createMemoryPromptRegistration();
  const flush = createMemoryFlushPlanResolver();
  const legacyFlushPlan = createLegacyMemoryFlushPlanRegistration();
  const legacyFlushRegistration = createLegacyMemoryFlushRegistration(memoryManager);
  const embedding = createMemoryEmbeddingRegistration(memoryManager);
  const capability: OpenClawMemoryCapabilityRegistration = {
    runtime,
    prompt: {
      async buildPromptSection(params) {
        return buildLegacyPromptSection(memoryManager, params);
      }
    },
    flush: legacyFlushRegistration,
    embedding: {
      probeAvailability: embedding.probeAvailability,
      isVectorAvailable: embedding.isVectorAvailable
    }
  };

  const maybeRegisterMemoryCapability = api.registerMemoryCapability;
  const hasCapabilityApi = typeof maybeRegisterMemoryCapability === "function";
  if (typeof maybeRegisterMemoryCapability === "function") {
    maybeRegisterMemoryCapability(capability);
  }

  const maybeRegisterMemoryRuntime = api.registerMemoryRuntime;
  if (typeof maybeRegisterMemoryRuntime === "function") {
    maybeRegisterMemoryRuntime(runtime);
  }

  const maybeRegisterMemoryPromptSection = api.registerMemoryPromptSection;
  if (typeof maybeRegisterMemoryPromptSection === "function") {
    maybeRegisterMemoryPromptSection(prompt);
  }

  const maybeRegisterMemoryFlushPlanResolver = typeof api.registerMemoryFlushPlanResolver === "function"
    ? api.registerMemoryFlushPlanResolver
    : null;
  let didRegisterMemoryFlushPlanResolver = false;
  if (typeof maybeRegisterMemoryFlushPlanResolver === "function") {
    maybeRegisterMemoryFlushPlanResolver(flush);
    didRegisterMemoryFlushPlanResolver = true;
  }

  const maybeRegisterMemoryFlushPlan = typeof api.registerMemoryFlushPlan === "function"
    ? api.registerMemoryFlushPlan
    : null;
  if (!didRegisterMemoryFlushPlanResolver && typeof maybeRegisterMemoryFlushPlan === "function") {
    maybeRegisterMemoryFlushPlan(legacyFlushPlan);
  }

  const maybeRegisterMemoryEmbeddingProvider = api.registerMemoryEmbeddingProvider;
  if (typeof maybeRegisterMemoryEmbeddingProvider === "function") {
    maybeRegisterMemoryEmbeddingProvider(embedding, { ownerPluginId: api.id });
  }

  const maybeRegisterMemoryPrompt = api.registerMemoryPrompt;
  if (typeof maybeRegisterMemoryPrompt === "function") {
    const legacyPrompt: OpenClawMemoryPromptRegistration = capability.prompt;
    maybeRegisterMemoryPrompt(legacyPrompt);
  }

  const maybeRegisterMemoryFlush = api.registerMemoryFlush;
  if (typeof maybeRegisterMemoryFlush === "function") {
    const legacyFlush: OpenClawMemoryFlushRegistration = legacyFlushRegistration;
    maybeRegisterMemoryFlush(legacyFlush);
  }

  const maybeRegisterMemoryEmbedding = api.registerMemoryEmbedding;
  if (typeof maybeRegisterMemoryEmbedding === "function") {
    const legacyEmbedding: OpenClawMemoryEmbeddingRegistration = capability.embedding;
    maybeRegisterMemoryEmbedding(legacyEmbedding);
  }

  return hasCapabilityApi;
}

function registerOpenClawPlugin(api: OpenClawPluginApi): {
  plugins?: { slots: { memory: ClawVaultMemoryManager } };
} {
  const pluginConfig = readPluginConfig(api);
  const runtimeState = RUNTIME_STATE_BY_API.get(api) ?? new ClawVaultPluginRuntimeState();
  RUNTIME_STATE_BY_API.set(api, runtimeState);
  const memoryManager = new ClawVaultMemoryManager({
    pluginConfig,
    defaultAgentId: "main",
    logger: {
      debug: api.logger.debug,
      warn: api.logger.warn
    }
  });
  const hasCapabilityApi = registerMemoryContractSurface(api, memoryManager, pluginConfig);

  api.registerTool(createMemorySearchToolFactory(memoryManager), { name: "memory_search" });
  api.registerTool(createMemoryGetToolFactory(memoryManager), { name: "memory_get" });
  api.registerTool(createMemoryCategoriesToolFactory({
    pluginConfig,
    defaultAgentId: "main"
  }), { name: "memory_categories" });
  api.registerTool(createMemoryClassifyToolFactory({
    pluginConfig,
    defaultAgentId: "main"
  }), { name: "memory_classify" });
  const memoryWriteToolOptions = {
    pluginConfig,
    defaultAgentId: "main"
  };
  api.registerTool(createMemoryWriteVaultToolFactory(memoryWriteToolOptions), { name: "memory_write_vault" });
  api.registerTool(createMemoryWriteBootToolFactory(memoryWriteToolOptions), { name: "memory_write_boot" });
  api.registerTool(createMemoryCaptureSourceToolFactory(memoryWriteToolOptions), { name: "memory_capture_source" });
  api.registerTool(createMemoryUpdateToolFactory(memoryWriteToolOptions, "memory_update"), { name: "memory_update" });
  api.registerTool(createMemoryUpdateToolFactory(memoryWriteToolOptions, "memory_patch"), { name: "memory_patch" });
  void maybeEmitOnboardingRequiredPrompt(api, pluginConfig, runtimeState).catch((error) => {
    const detail = error instanceof Error ? error.message : String(error);
    api.logger.warn(`[clawvault] failed to emit onboarding prompt/event: ${detail}`);
  });

  const agentEndWritebackHandler = createAgentEndWritebackHandler(pluginConfig);
  const captureObservationEnabled = isPackEnabled(pluginConfig, "capture-observation");

  if (isAutomationModeEnabled(pluginConfig)) {
    registerAutomationHooks(api, {
      pluginConfig,
      runtimeState,
      memoryManager,
      agentEndWritebackHandler: captureObservationEnabled
        ? async (event, ctx) => agentEndWritebackHandler(event, ctx, { pluginConfig, logger: api.logger })
        : undefined
    });
  }

  if (!captureObservationEnabled) {
    // Writeback handler remains available when capture-observation automation is off.
    api.on("agent_end", async (event, ctx) => {
      await agentEndWritebackHandler(event, ctx, { pluginConfig, logger: api.logger });
    });
  }

  if (hasCapabilityApi) {
    return {};
  }

  return {
    plugins: {
      slots: {
        memory: memoryManager
      }
    }
  };
}

const clawvaultPlugin = {
  id: "clawvault",
  name: "ClawVault",
  kind: "memory" as const,
  description: "Structured memory system for AI agents with proactive recall and protocol-safe messaging",
  register(apiOrRuntime?: unknown) {
    if (isOpenClawPluginApi(apiOrRuntime)) {
      return registerOpenClawPlugin(apiOrRuntime);
    }

    if (apiOrRuntime && typeof apiOrRuntime === "object") {
      registerMemorySlot(apiOrRuntime as Record<string, unknown>);
    }
    return createMemorySlotPlugin();
  }
};

export default clawvaultPlugin;
export { createMemorySlotPlugin };
