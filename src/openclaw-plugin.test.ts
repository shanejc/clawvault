import { describe, expect, it, vi } from "vitest";
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
        vaultPath: "/tmp/does-not-exist",
        ...pluginConfig
      },
      registerTool,
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
      registerTool
    };
  }

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
    const callback = vi.fn(async () => ({ prependSystemContext: "callback-mode-context" }));
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
    expect(result).toEqual({ prependSystemContext: "callback-mode-context", appendSystemContext: undefined });
    expect((result as { prependSystemContext?: string }).prependSystemContext).not.toContain("ClawVault Memory Recall Guidance");
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
});
