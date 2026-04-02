import { beforeEach, describe, expect, it, vi } from "vitest";
import clawvaultPlugin from "./openclaw-plugin.js";
import type { ClawVaultPluginConfig } from "./plugin/config.js";

/*
Expected preset automation matrix (keep in sync with src/openclaw-plugin.ts):
| preset | hooks |
| --- | --- |
| thin | (none) |
| hybrid | before_prompt_build, gateway_start, session_start, session_end, before_reset |
| legacy | before_prompt_build, message_sending, gateway_start, session_start, session_end, before_reset, before_compaction, agent_end |

Tools are always registered for every preset:
memory_search, memory_get, memory_categories, memory_classify,
memory_write_vault, memory_write_boot, memory_capture_source, memory_update, memory_patch
*/

describe("openclaw plugin registration", () => {
  beforeEach(() => {
    (globalThis as Record<string, unknown>).__clawvaultOnboardingPromptedInProcess = false;
  });

  const expectedToolNames = [
    "memory_search",
    "memory_get",
    "memory_categories",
    "memory_classify",
    "memory_write_vault",
    "memory_write_boot",
    "memory_capture_source",
    "memory_update",
    "memory_patch"
  ];

  function registerWithConfig(pluginConfig: ClawVaultPluginConfig = {}) {
    const hookNames: string[] = [];
    const hookHandlers = new Map<string, (...args: unknown[]) => unknown>();
    const registerTool = vi.fn();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn()
    };

    const api = {
      id: "clawvault",
      name: "ClawVault",
      logger,
      pluginConfig: {
        vaultPath: "/tmp/does-not-exist",
        ...pluginConfig
      },
      registerTool,
      emitRuntimeEvent: vi.fn(),
      on: vi.fn((hookName: string, handler: (...args: unknown[]) => unknown) => {
        hookNames.push(hookName);
        hookHandlers.set(hookName, handler);
      })
    };

    const result = clawvaultPlugin.register(api);

    return {
      result,
      hookNames,
      hookHandlers,
      registerTool,
      logger,
      emitRuntimeEvent: api.emitRuntimeEvent
    };
  }

  it("emits first-run onboarding prompt/event when pack preset is unset", async () => {
    const { logger, emitRuntimeEvent } = registerWithConfig({});
    await Promise.resolve();

    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("Run `clawvault openclaw onboard`"));
    expect(emitRuntimeEvent).toHaveBeenCalledWith("clawvault:onboarding_required", {
      reason: "missing_pack_preset",
      configPaths: ["packPreset", "automationPreset"],
      command: "clawvault openclaw onboard"
    });
  });

  it("skips onboarding prompt/event when non-preset automation config is already explicit", async () => {
    const { logger, emitRuntimeEvent } = registerWithConfig({
      automationMode: true
    });
    await Promise.resolve();

    expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining("clawvault openclaw onboard"));
    expect(emitRuntimeEvent).not.toHaveBeenCalledWith("clawvault:onboarding_required", expect.anything());
  });

  it("suppresses onboarding prompts across re-registration with new API objects in the same process", async () => {
    const createApi = () => ({
      id: "clawvault",
      name: "ClawVault",
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn()
      },
      pluginConfig: {
        vaultPath: "/tmp/does-not-exist"
      },
      registerTool: vi.fn(),
      on: vi.fn((_: string, __: (...args: unknown[]) => unknown) => {}),
      emitRuntimeEvent: vi.fn()
    });
    const firstApi = createApi();
    const secondApi = createApi();

    clawvaultPlugin.register(firstApi);
    await Promise.resolve();
    clawvaultPlugin.register(secondApi);
    await Promise.resolve();

    expect(firstApi.logger.info).toHaveBeenCalledTimes(1);
    expect(secondApi.logger.info).toHaveBeenCalledTimes(0);
    expect(firstApi.emitRuntimeEvent).toHaveBeenCalledTimes(1);
    expect(secondApi.emitRuntimeEvent).toHaveBeenCalledTimes(0);
  });

  it("suppresses repeated onboarding prompts when re-registering the same API object", async () => {
    const api = {
      id: "clawvault",
      name: "ClawVault",
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn()
      },
      pluginConfig: {
        vaultPath: "/tmp/does-not-exist"
      },
      registerTool: vi.fn(),
      on: vi.fn((_: string, __: (...args: unknown[]) => unknown) => {}),
      emitRuntimeEvent: vi.fn()
    };

    clawvaultPlugin.register(api);
    await Promise.resolve();
    clawvaultPlugin.register(api);
    await Promise.resolve();

    expect(api.logger.info).toHaveBeenCalledTimes(1);
    expect(api.emitRuntimeEvent).toHaveBeenCalledTimes(1);
  });

  it("logs a warning when onboarding runtime event emission fails", async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn()
    };
    clawvaultPlugin.register({
      id: "clawvault",
      name: "ClawVault",
      logger,
      pluginConfig: {
        vaultPath: "/tmp/does-not-exist"
      },
      registerTool: vi.fn(),
      on: vi.fn((hookName: string, handler: (...args: unknown[]) => unknown) => {}),
      emitRuntimeEvent: vi.fn(async () => {
        throw new Error("emit-failed");
      })
    });

    await new Promise<void>((resolve) => {
      setImmediate(() => resolve());
    });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("failed to emit onboarding prompt/event: emit-failed"));
  });

  it("registers substrate synchronously by default", () => {
    const { result } = registerWithConfig();

    // Critical: OpenClaw discards Promises from register(). Must be sync.
    expect(result).toBeDefined();
    expect(typeof (result as { then?: unknown }).then).not.toBe("function");

    const memorySlot = (result as { plugins: { slots: { memory: unknown } } }).plugins.slots.memory as {
      search?: unknown;
      readFile?: unknown;
      status?: unknown;
    };
    expect(typeof memorySlot.search).toBe("function");
    expect(typeof memorySlot.readFile).toBe("function");
    expect(typeof memorySlot.status).toBe("function");
  });

  it.each([
    {
      preset: "thin",
      expectedHooks: []
    },
    {
      preset: "hybrid",
      expectedHooks: ["before_prompt_build", "gateway_start", "session_start", "session_end", "before_reset"]
    },
    {
      preset: "legacy",
      expectedHooks: [
        "before_prompt_build",
        "message_sending",
        "gateway_start",
        "session_start",
        "session_end",
        "before_reset",
        "before_compaction",
        "agent_end"
      ]
    }
  ] as const)("applies exact hook/tool behavior for $preset preset", ({ preset, expectedHooks }) => {
    const { hookNames, registerTool } = registerWithConfig({ packPreset: preset });

    const registeredToolNames = registerTool.mock.calls
      .map(([, metadata]) => (metadata as { name?: string })?.name)
      .filter((name): name is string => typeof name === "string");

    expect(registerTool).toHaveBeenCalledTimes(expectedToolNames.length);
    expect(registeredToolNames).toEqual(expectedToolNames);
    expect(hookNames).toEqual(expectedHooks);
  });

  it("registers communication-policy hooks when communication pack is enabled", () => {
    const { hookNames } = registerWithConfig({
      packToggles: {
        "legacy-communication-policy": true
      }
    });

    expect(hookNames).toEqual(["before_prompt_build", "message_sending"]);
  });

  it("dispatches callback handlers for callback mode without running built-in before_prompt_build automation", async () => {
    const callback = vi.fn(async () => ({ decision: "handled", prependSystemContext: "callback-mode-context" }));
    const { hookHandlers } = registerWithConfig({
      memoryBehaviorDomains: {
        "session-memory": "callback"
      },
      memoryBehaviorCallbacks: {
        "session-memory": callback
      },
      enableBeforePromptRecall: true
    });

    const beforePromptBuild = hookHandlers.get("before_prompt_build");
    expect(beforePromptBuild).toBeTypeOf("function");

    const result = await beforePromptBuild?.({ prompt: "status?", messages: [] }, {});
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0]?.[0]).toMatchObject({
      domain: "session-memory",
      trigger: "before_prompt_build",
      context: {
        event: { prompt: "status?", messages: [] },
        hookContext: {}
      },
      suggestedActions: [
        "prepend_context",
        "append_context",
        "prepend_system_context",
        "append_system_context",
        "rewrite_system_prompt"
      ]
    });
    expect((callback.mock.calls[0]?.[0] as { correlationId?: string }).correlationId).toMatch(
      /^clawvault:session-memory:before_prompt_build:\d+$/
    );
    expect(result).toEqual({ prependSystemContext: "callback-mode-context", appendSystemContext: undefined });
    expect((result as { prependSystemContext?: string }).prependSystemContext).not.toContain("ClawVault Memory Recall Guidance");
  });

  it("prefers API callback invoker when provided and emits runtime callback events", async () => {
    const invokeClawVaultCallback = vi.fn(async () => ({ decision: "handled", prependSystemContext: "from-api" }));
    const emitRuntimeEvent = vi.fn();
    const hookHandlers = new Map<string, (...args: unknown[]) => unknown>();

    clawvaultPlugin.register({
      id: "clawvault",
      name: "ClawVault",
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn()
      },
      pluginConfig: {
        vaultPath: "/tmp/does-not-exist",
        memoryBehaviorDomains: {
          "session-memory": "callback"
        },
        memoryBehaviorCallbacks: {
          "session-memory": vi.fn(async () => ({ decision: "handled", prependSystemContext: "from-config-callback" }))
        }
      },
      registerTool: vi.fn(),
      on: vi.fn((hookName: string, handler: (...args: unknown[]) => unknown) => {
        hookHandlers.set(hookName, handler);
      }),
      emitRuntimeEvent,
      invokeClawVaultCallback
    });

    const beforePromptBuild = hookHandlers.get("before_prompt_build");
    const result = await beforePromptBuild?.({ prompt: "status?", messages: [] }, {});
    expect(invokeClawVaultCallback).toHaveBeenCalledTimes(1);
    expect(emitRuntimeEvent).toHaveBeenCalledWith(
      "clawvault:callback_invocation",
      expect.objectContaining({
        domain: "session-memory",
        trigger: "before_prompt_build"
      })
    );
    expect(result).toEqual({ prependSystemContext: "from-api", appendSystemContext: undefined });
  });

  it("uses deterministic fallback when callback invocation fails or times out", async () => {
    const invokeClawVaultCallback = vi.fn(async () => {
      throw new Error("forced-failure");
    });
    const { logger } = registerWithConfig();

    // Re-register with explicit API invoker to drive timeout path.
    const map = new Map<string, (...args: unknown[]) => unknown>();
    clawvaultPlugin.register({
      id: "clawvault",
      name: "ClawVault",
      logger,
      pluginConfig: {
        vaultPath: "/tmp/does-not-exist",
        memoryBehaviorDomains: {
          "legacy-communication-policy": "callback"
        },
        memoryBehaviorCallbackTimeoutMs: 1
      },
      registerTool: vi.fn(),
      on: vi.fn((hookName: string, handler: (...args: unknown[]) => unknown) => {
        map.set(hookName, handler);
      }),
      invokeClawVaultCallback
    });

    const messageSending = map.get("message_sending");
    const result = await messageSending?.({ to: "ops", content: "hello" }, { channelId: "ch_1" });
    expect(result).toEqual({ cancel: false });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("callback invocation failed"));
  });

  it("rejects invalid callback shapes and uses safe fallback", async () => {
    const invokeClawVaultCallback = vi.fn(async () => ({ prependSystemContext: "missing-decision" }));
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn()
    };
    const map = new Map<string, (...args: unknown[]) => unknown>();

    clawvaultPlugin.register({
      id: "clawvault",
      name: "ClawVault",
      logger,
      pluginConfig: {
        vaultPath: "/tmp/does-not-exist",
        memoryBehaviorDomains: {
          "legacy-communication-policy": "callback"
        }
      },
      registerTool: vi.fn(),
      on: vi.fn((hookName: string, handler: (...args: unknown[]) => unknown) => {
        map.set(hookName, handler);
      }),
      invokeClawVaultCallback
    });

    const messageSending = map.get("message_sending");
    const result = await messageSending?.({ to: "ops", content: "hello" }, { channelId: "ch_1" });
    expect(result).toEqual({ cancel: false });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("invalid callback decision"));
  });

  it("logs and ignores unsupported callback fields for the active trigger", async () => {
    const invokeClawVaultCallback = vi.fn(async () => ({
      decision: "handled",
      cancel: true,
      prependSystemContext: "not-allowed-for-message-sending"
    }));
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn()
    };
    const map = new Map<string, (...args: unknown[]) => unknown>();

    clawvaultPlugin.register({
      id: "clawvault",
      name: "ClawVault",
      logger,
      pluginConfig: {
        vaultPath: "/tmp/does-not-exist",
        memoryBehaviorDomains: {
          "legacy-communication-policy": "callback"
        }
      },
      registerTool: vi.fn(),
      on: vi.fn((hookName: string, handler: (...args: unknown[]) => unknown) => {
        map.set(hookName, handler);
      }),
      invokeClawVaultCallback
    });

    const messageSending = map.get("message_sending");
    const result = await messageSending?.({ to: "ops", content: "hello" }, { channelId: "ch_1" });
    expect(result).toEqual({ content: undefined, cancel: true });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("unsupported callback field prependSystemContext"));
  });

  it("applies timeout fallback for stalled callback invocations", async () => {
    const invokeClawVaultCallback = vi.fn(() => new Promise<unknown>(() => {}));
    const map = new Map<string, (...args: unknown[]) => unknown>();

    clawvaultPlugin.register({
      id: "clawvault",
      name: "ClawVault",
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn()
      },
      pluginConfig: {
        vaultPath: "/tmp/does-not-exist",
        memoryBehaviorDomains: {
          "legacy-communication-policy": "callback"
        },
        memoryBehaviorCallbackTimeoutMs: 50
      },
      registerTool: vi.fn(),
      on: vi.fn((hookName: string, handler: (...args: unknown[]) => unknown) => {
        map.set(hookName, handler);
      }),
      invokeClawVaultCallback
    });

    const messageSending = map.get("message_sending");
    const started = Date.now();
    const result = await messageSending?.({ to: "ops", content: "hello" }, { channelId: "ch_1" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
    expect(result).toEqual({ cancel: false });
  });

  it("supports fallbackToAuto policy when callback invocation fails", async () => {
    const invokeClawVaultCallback = vi.fn(async () => {
      throw new Error("forced-failure");
    });
    const map = new Map<string, (...args: unknown[]) => unknown>();

    clawvaultPlugin.register({
      id: "clawvault",
      name: "ClawVault",
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn()
      },
      pluginConfig: {
        vaultPath: "/tmp/does-not-exist",
        memoryBehaviorDomains: {
          "session-memory": "callback"
        },
        memoryBehaviorCallbackPolicy: "fallbackToAuto",
        enableBeforePromptRecall: true
      },
      registerTool: vi.fn(),
      on: vi.fn((hookName: string, handler: (...args: unknown[]) => unknown) => {
        map.set(hookName, handler);
      }),
      invokeClawVaultCallback
    });

    const beforePromptBuild = map.get("before_prompt_build");
    const result = await beforePromptBuild?.({ prompt: "hello", messages: [] }, {});
    expect((result as { prependSystemContext?: string } | undefined)?.prependSystemContext).toContain("ClawVault Memory Recall Guidance");
  });

  it("throws with hardFail policy when callback handler is required but missing", async () => {
    const map = new Map<string, (...args: unknown[]) => unknown>();

    clawvaultPlugin.register({
      id: "clawvault",
      name: "ClawVault",
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn()
      },
      pluginConfig: {
        vaultPath: "/tmp/does-not-exist",
        memoryBehaviorDomains: {
          "legacy-communication-policy": "callback"
        },
        memoryBehaviorCallbackPolicy: "hardFail"
      },
      registerTool: vi.fn(),
      on: vi.fn((hookName: string, handler: (...args: unknown[]) => unknown) => {
        map.set(hookName, handler);
      })
    });

    const messageSending = map.get("message_sending");
    await expect(messageSending?.({ to: "ops", content: "hello" }, { channelId: "ch_1" })).rejects.toThrow(
      "callback policy hardFail triggered"
    );
  });

  it("does not dispatch callbacks when the pack/domain is off", async () => {
    const callback = vi.fn();
    const { hookNames } = registerWithConfig({
      packPreset: "thin",
      memoryBehaviorCallbacks: {
        "session-memory": callback
      }
    });

    expect(hookNames).toEqual([]);
    expect(callback).not.toHaveBeenCalled();
  });

  it.each([
    {
      hookName: "before_prompt_build",
      event: { prompt: "hello", messages: [] },
      ctx: {},
      behaviorConfig: {
        memoryBehaviorDomains: {
          "session-memory": "callback"
        },
        enableBeforePromptRecall: true
      },
      handledResult: { decision: "handled", prependSystemContext: "handled-context" },
      expectedHandled: { prependSystemContext: "handled-context", appendSystemContext: undefined },
      expectedErrorResult: undefined,
      autoCheck: (result: unknown) => {
        expect((result as { prependSystemContext?: string } | undefined)?.prependSystemContext).toContain(
          "ClawVault Memory Recall Guidance"
        );
      },
      errorLog: "[clawvault] before_prompt_build callback returned error decision; skipping callback output"
    },
    {
      hookName: "message_sending",
      event: { to: "ops", content: "good catch, thanks." },
      ctx: { channelId: "ch_1" },
      behaviorConfig: {
        memoryBehaviorDomains: {
          "legacy-communication-policy": "callback"
        },
        enableMessageSendingFilter: true
      },
      handledResult: { decision: "handled", content: "callback-rewrite", cancel: true },
      expectedHandled: { content: "callback-rewrite", cancel: true },
      expectedErrorResult: { cancel: false },
      autoCheck: (result: unknown) => {
        expect(result).toEqual({ content: "thanks." });
      },
      errorLog: "[clawvault] message_sending callback returned error decision; using safe fallback"
    }
  ])(
    "table-driven callback outcomes for $hookName include handled/skip/fallback_auto/error",
    async ({ hookName, event, ctx, behaviorConfig, handledResult, expectedHandled, expectedErrorResult, autoCheck, errorLog }) => {
      const emitRuntimeEvent = vi.fn();
      const logger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn()
      };
      const map = new Map<string, (...args: unknown[]) => unknown>();
      const invokeClawVaultCallback = vi.fn(async () => handledResult);

      clawvaultPlugin.register({
        id: "clawvault",
        name: "ClawVault",
        logger,
        pluginConfig: {
          vaultPath: "/tmp/does-not-exist",
          memoryBehaviorCallbackPolicy: "legacy",
          ...behaviorConfig
        },
        registerTool: vi.fn(),
        on: vi.fn((registeredHookName: string, handler: (...args: unknown[]) => unknown) => {
          map.set(registeredHookName, handler);
        }),
        invokeClawVaultCallback,
        emitRuntimeEvent
      });

      const hook = map.get(hookName);
      expect(hook).toBeTypeOf("function");

      const handledOutput = await hook?.(event, ctx);
      expect(handledOutput).toEqual(expectedHandled);

      invokeClawVaultCallback.mockResolvedValueOnce({ decision: "skip" });
      const skipOutput = await hook?.(event, ctx);
      expect(skipOutput).toBeUndefined();

      invokeClawVaultCallback.mockResolvedValueOnce({ decision: "fallback_auto" });
      const fallbackAutoOutput = await hook?.(event, ctx);
      autoCheck(fallbackAutoOutput);

      invokeClawVaultCallback.mockResolvedValueOnce({ decision: "error" });
      const errorOutput = await hook?.(event, ctx);
      expect(errorOutput).toEqual(expectedErrorResult);
      expect(logger.warn).toHaveBeenCalledWith(errorLog);
      expect(emitRuntimeEvent).toHaveBeenCalledWith(
        "clawvault:callback_invocation",
        expect.objectContaining({
          trigger: hookName
        })
      );
    }
  );

  it.each([
    { policy: undefined, expectedResult: { cancel: false }, expectAuto: false, expectedWarning: "callback invocation failed" },
    {
      policy: "fallbackToAuto",
      expectedResult: { content: "thanks." },
      expectAuto: true,
      expectedWarning: "callback policy fallbackToAuto applied"
    },
    {
      policy: "skip",
      expectedResult: undefined,
      expectAuto: false,
      expectedWarning: "callback policy skip applied"
    }
  ] as const)(
    "policy behavior on invoker failure for message_sending: %o",
    async ({ policy, expectedResult, expectAuto, expectedWarning }) => {
      const logger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn()
      };
      const map = new Map<string, (...args: unknown[]) => unknown>();

      clawvaultPlugin.register({
        id: "clawvault",
        name: "ClawVault",
        logger,
        pluginConfig: {
          vaultPath: "/tmp/does-not-exist",
          memoryBehaviorDomains: {
            "legacy-communication-policy": "callback"
          },
          enableMessageSendingFilter: true,
          memoryBehaviorCallbackPolicy: policy
        },
        registerTool: vi.fn(),
        on: vi.fn((hookName: string, handler: (...args: unknown[]) => unknown) => {
          map.set(hookName, handler);
        }),
        invokeClawVaultCallback: vi.fn(async () => {
          throw new Error("forced-failure");
        })
      });

      const messageSending = map.get("message_sending");
      const result = await messageSending?.({ to: "ops", content: "good catch, thanks." }, { channelId: "ch_1" });
      expect(result).toEqual(expectedResult);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(expectedWarning));
      if (expectAuto) {
        expect(result).toEqual({ content: "thanks." });
      }
    }
  );

  it("supports timeout path for callback mode with default compatibility fallback", async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn()
    };
    const map = new Map<string, (...args: unknown[]) => unknown>();
    clawvaultPlugin.register({
      id: "clawvault",
      name: "ClawVault",
      logger,
      pluginConfig: {
        vaultPath: "/tmp/does-not-exist",
        memoryBehaviorDomains: {
          "legacy-communication-policy": "callback"
        },
        memoryBehaviorCallbackTimeoutMs: 50
      },
      registerTool: vi.fn(),
      on: vi.fn((hookName: string, handler: (...args: unknown[]) => unknown) => {
        map.set(hookName, handler);
      }),
      invokeClawVaultCallback: vi.fn(() => new Promise<unknown>(() => {}))
    });

    const messageSending = map.get("message_sending");
    const result = await messageSending?.({ to: "ops", content: "hello" }, { channelId: "ch_1" });
    expect(result).toEqual({ cancel: false });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("callback_timeout_50ms"));
  });

  it("enforces hard-fail mode for invalid response shape and missing callback handler", async () => {
    const mapWithInvoker = new Map<string, (...args: unknown[]) => unknown>();
    clawvaultPlugin.register({
      id: "clawvault",
      name: "ClawVault",
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn()
      },
      pluginConfig: {
        vaultPath: "/tmp/does-not-exist",
        memoryBehaviorDomains: {
          "legacy-communication-policy": "callback"
        },
        memoryBehaviorCallbackPolicy: "hardFail"
      },
      registerTool: vi.fn(),
      on: vi.fn((hookName: string, handler: (...args: unknown[]) => unknown) => {
        mapWithInvoker.set(hookName, handler);
      }),
      invokeClawVaultCallback: vi.fn(async () => ({ invalid: true }))
    });

    await expect(mapWithInvoker.get("message_sending")?.({ to: "ops", content: "hello" }, { channelId: "ch_1" })).rejects.toThrow(
      "callback policy hardFail triggered"
    );

    const mapWithoutHandler = new Map<string, (...args: unknown[]) => unknown>();
    clawvaultPlugin.register({
      id: "clawvault",
      name: "ClawVault",
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn()
      },
      pluginConfig: {
        vaultPath: "/tmp/does-not-exist",
        memoryBehaviorDomains: {
          "legacy-communication-policy": "callback"
        },
        memoryBehaviorCallbackPolicy: "hardFail"
      },
      registerTool: vi.fn(),
      on: vi.fn((hookName: string, handler: (...args: unknown[]) => unknown) => {
        mapWithoutHandler.set(hookName, handler);
      })
    });

    await expect(
      mapWithoutHandler.get("message_sending")?.({ to: "ops", content: "hello" }, { channelId: "ch_1" })
    ).rejects.toThrow("callback policy hardFail triggered");
  });

  it("covers lifecycle callback decisions and fallback policy behavior for gateway_start", async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn()
    };
    const map = new Map<string, (...args: unknown[]) => unknown>();
    const invokeClawVaultCallback = vi.fn(async () => ({ decision: "handled" }));
    clawvaultPlugin.register({
      id: "clawvault",
      name: "ClawVault",
      logger,
      pluginConfig: {
        vaultPath: "",
        enableStartupRecovery: true,
        memoryBehaviorDomains: {
          "session-memory": "callback"
        },
        memoryBehaviorCallbackPolicy: "legacy"
      },
      registerTool: vi.fn(),
      on: vi.fn((hookName: string, handler: (...args: unknown[]) => unknown) => {
        map.set(hookName, handler);
      }),
      invokeClawVaultCallback
    });

    const gatewayStart = map.get("gateway_start");
    await gatewayStart?.({ port: 3377 }, { port: 3377 });
    invokeClawVaultCallback.mockResolvedValueOnce({ decision: "skip" });
    await gatewayStart?.({ port: 3377 }, { port: 3377 });
    invokeClawVaultCallback.mockResolvedValueOnce({ decision: "error" });
    await gatewayStart?.({ port: 3377 }, { port: 3377 });
    expect(logger.warn).toHaveBeenCalledWith("[clawvault] gateway_start callback returned error decision; continuing safely");

    invokeClawVaultCallback.mockResolvedValueOnce({ decision: "fallback_auto" });
    await gatewayStart?.({ port: 3377 }, { port: 3377 });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("No vault found, skipping startup recovery"));
  });

  it.each([
    { distillationOutcome: "local_run_approved", expectedInfoLog: undefined },
    {
      distillationOutcome: "delegated_event",
      expectedInfoLog: "[clawvault] reflection-maintenance delegated distillation (session_start, correlationId=clawvault:reflection-maintenance:session_start:1)"
    },
    {
      distillationOutcome: "queued_for_approval",
      expectedInfoLog: "[clawvault] reflection-maintenance queued distillation for approval (session_start, correlationId=clawvault:reflection-maintenance:session_start:1)"
    },
    {
      distillationOutcome: "skipped",
      expectedInfoLog: "[clawvault] reflection-maintenance distillation skipped (session_start, correlationId=clawvault:reflection-maintenance:session_start:1)"
    }
  ] as const)("orchestrates reflection-maintenance callback outcomes: $distillationOutcome", async ({ distillationOutcome, expectedInfoLog }) => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn()
    };
    const emitRuntimeEvent = vi.fn();
    const map = new Map<string, (...args: unknown[]) => unknown>();

    clawvaultPlugin.register({
      id: "clawvault",
      name: "ClawVault",
      logger,
      pluginConfig: {
        vaultPath: "/tmp/does-not-exist",
        memoryBehaviorDomains: {
          "reflection-maintenance": "callback"
        },
        memoryBehaviorCallbackPolicy: "legacy"
      },
      registerTool: vi.fn(),
      on: vi.fn((hookName: string, handler: (...args: unknown[]) => unknown) => {
        map.set(hookName, handler);
      }),
      emitRuntimeEvent,
      invokeClawVaultCallback: vi.fn(async () => ({
        decision: "handled",
        distillationOutcome,
        note: "orchestration-note"
      }))
    });

    const sessionStart = map.get("session_start");
    await sessionStart?.({ sessionId: "s_1", sessionKey: "agent/main" }, { sessionId: "s_1", sessionKey: "agent/main", agentId: "main" });

    expect(emitRuntimeEvent).toHaveBeenCalledWith(
      "clawvault:distillation_orchestration",
      expect.objectContaining({
        domain: "reflection-maintenance",
        trigger: "session_start",
        outcome: distillationOutcome
      })
    );
    if (expectedInfoLog) {
      expect(logger.info).toHaveBeenCalledWith(expectedInfoLog);
    }
  });
});
