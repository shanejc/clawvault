import { createMemorySlotPlugin, registerMemorySlot } from "./plugin/slot.js";
import { getPackBehaviorMode, isPackEnabled, readPluginConfig } from "./plugin/config.js";
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
  handleBeforeCompactionObservation
} from "./plugin/hooks/observation.js";
import type {
  ClawVaultCallbackPayload,
  OpenClawPluginApi,
  PluginHookMessageSendingResult,
  PluginHookName
} from "./plugin/openclaw-types.js";
import type { ClawVaultPluginConfig } from "./plugin/config.js";
import type { ClawVaultAutomationPack } from "./plugin/packs.js";

interface AutomationHookDependencies {
  pluginConfig: ClawVaultPluginConfig;
  runtimeState: ClawVaultPluginRuntimeState;
  memoryManager: ClawVaultMemoryManager;
}

const AUTOMATION_PACKS: readonly ClawVaultAutomationPack[] = [
  "session-memory",
  "capture-observation",
  "reflection-maintenance",
  "legacy-communication-policy"
] as const;

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

async function dispatchPackCallback(
  api: OpenClawPluginApi,
  pluginConfig: ClawVaultPluginConfig,
  pack: ClawVaultAutomationPack,
  hookName: PluginHookName,
  event: unknown,
  ctx: unknown,
  sequence: number
): Promise<unknown> {
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
      return await invokeWithTimeout(api.invokeClawVaultCallback);
    } catch (error) {
      api.logger.warn(formatCallbackFailure(pack, hookName, payload.correlationId, error));
      return getCallbackFallback(hookName);
    }
  }

  const callback = pluginConfig.memoryBehaviorCallbacks?.[pack];
  if (typeof callback !== "function") {
    return;
  }
  try {
    return await invokeWithTimeout(callback);
  } catch (error) {
    api.logger.warn(formatCallbackFailure(pack, hookName, payload.correlationId, error));
    return getCallbackFallback(hookName);
  }
}

function createCallbackPayload(
  pack: ClawVaultAutomationPack,
  hookName: PluginHookName,
  event: unknown,
  ctx: unknown,
  sequence: number
): ClawVaultCallbackPayload {
  return {
    domain: pack,
    trigger: hookName,
    context: {
      event,
      hookContext: ctx
    },
    suggestedActions: getSuggestedActions(hookName),
    correlationId: `clawvault:${pack}:${hookName}:${sequence}`
  };
}

function getSuggestedActions(hookName: PluginHookName): string[] {
  if (hookName === "before_prompt_build") {
    return ["prepend_system_context", "append_system_context"];
  }
  if (hookName === "message_sending") {
    return ["rewrite_message", "cancel_message"];
  }
  return ["observe_only"];
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

function getCallbackFallback(hookName: PluginHookName): unknown {
  if (hookName === "message_sending") {
    return { cancel: false } satisfies PluginHookMessageSendingResult;
  }
  return;
}

function mergeBeforePromptBuildResults(results: unknown[]): { prependSystemContext?: string; appendSystemContext?: string } | void {
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

function registerAutomationHooks(api: OpenClawPluginApi, deps: AutomationHookDependencies): void {
  const { pluginConfig, runtimeState, memoryManager } = deps;
  const sessionMemoryMode = getPackBehaviorMode(pluginConfig, "session-memory");
  const captureObservationMode = getPackBehaviorMode(pluginConfig, "capture-observation");
  const reflectionMaintenanceMode = getPackBehaviorMode(pluginConfig, "reflection-maintenance");
  const communicationPolicyMode = getPackBehaviorMode(pluginConfig, "legacy-communication-policy");
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
      const results: unknown[] = [];
      if (beforePromptAutoPacks.length > 0) {
        results.push(await builtInBeforePromptBuildHandler(event, ctx));
      }
      if (sessionMemoryMode === "callback") {
        results.push(await dispatchPackCallback(api, pluginConfig, "session-memory", "before_prompt_build", event, ctx, nextSequence()));
      }
      if (communicationPolicyMode === "callback") {
        results.push(await dispatchPackCallback(api, pluginConfig, "legacy-communication-policy", "before_prompt_build", event, ctx, nextSequence()));
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
      const callbackResult = await dispatchPackCallback(
        api,
        pluginConfig,
        "legacy-communication-policy",
        "message_sending",
        event,
        ctx,
        nextSequence()
      );
      if (!callbackResult || typeof callbackResult !== "object") {
        return;
      }
      return callbackResult as PluginHookMessageSendingResult;
    }, { priority: 20 });
  }

  if (sessionMemoryEnabled || captureObservationEnabled || reflectionMaintenanceEnabled) {
    const lifecycleConfig = getEffectiveHookConfig(pluginConfig, lifecycleAutoPacks);
    api.on("gateway_start", async (event, ctx) => {
      if (lifecycleAutoPacks.length > 0) {
        await handleGatewayStart(event, ctx, {
          pluginConfig: lifecycleConfig,
          runtimeState,
          logger: api.logger
        });
      }
      if (sessionMemoryMode === "callback") {
        await dispatchPackCallback(api, pluginConfig, "session-memory", "gateway_start", event, ctx, nextSequence());
      }
      if (captureObservationMode === "callback") {
        await dispatchPackCallback(api, pluginConfig, "capture-observation", "gateway_start", event, ctx, nextSequence());
      }
      if (reflectionMaintenanceMode === "callback") {
        await dispatchPackCallback(api, pluginConfig, "reflection-maintenance", "gateway_start", event, ctx, nextSequence());
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
        await dispatchPackCallback(api, pluginConfig, "session-memory", "session_start", event, ctx, nextSequence());
      }
      if (captureObservationMode === "callback") {
        await dispatchPackCallback(api, pluginConfig, "capture-observation", "session_start", event, ctx, nextSequence());
      }
      if (reflectionMaintenanceMode === "callback") {
        await dispatchPackCallback(api, pluginConfig, "reflection-maintenance", "session_start", event, ctx, nextSequence());
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
        await dispatchPackCallback(api, pluginConfig, "session-memory", "session_end", event, ctx, nextSequence());
      }
      if (captureObservationMode === "callback") {
        await dispatchPackCallback(api, pluginConfig, "capture-observation", "session_end", event, ctx, nextSequence());
      }
      if (reflectionMaintenanceMode === "callback") {
        await dispatchPackCallback(api, pluginConfig, "reflection-maintenance", "session_end", event, ctx, nextSequence());
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
        await dispatchPackCallback(api, pluginConfig, "session-memory", "before_reset", event, ctx, nextSequence());
      }
      if (captureObservationMode === "callback") {
        await dispatchPackCallback(api, pluginConfig, "capture-observation", "before_reset", event, ctx, nextSequence());
      }
      if (reflectionMaintenanceMode === "callback") {
        await dispatchPackCallback(api, pluginConfig, "reflection-maintenance", "before_reset", event, ctx, nextSequence());
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
        await dispatchPackCallback(api, pluginConfig, "capture-observation", "before_compaction", event, ctx, nextSequence());
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
        await dispatchPackCallback(api, pluginConfig, "capture-observation", "agent_end", event, ctx, nextSequence());
      }
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

function registerOpenClawPlugin(api: OpenClawPluginApi): {
  plugins: { slots: { memory: ClawVaultMemoryManager } };
} {
  const pluginConfig = readPluginConfig(api);
  const runtimeState = new ClawVaultPluginRuntimeState();
  const memoryManager = new ClawVaultMemoryManager({
    pluginConfig,
    defaultAgentId: "main",
    logger: {
      debug: api.logger.debug,
      warn: api.logger.warn
    }
  });

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

  if (isAutomationModeEnabled(pluginConfig)) {
    registerAutomationHooks(api, {
      pluginConfig,
      runtimeState,
      memoryManager
    });
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
