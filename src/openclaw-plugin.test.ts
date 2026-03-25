import { describe, expect, it, vi } from "vitest";
import clawvaultPlugin from "./openclaw-plugin.js";

describe("openclaw plugin registration", () => {
  it("registers substrate synchronously by default (without automation hooks)", () => {
    const hookNames: string[] = [];
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
        vaultPath: "/tmp/does-not-exist"
      },
      registerTool,
      on: vi.fn((hookName: string) => {
        hookNames.push(hookName);
      })
    };

    const result = clawvaultPlugin.register(api);

    // Critical: OpenClaw discards Promises from register(). Must be sync.
    expect(result).toBeDefined();
    expect(typeof (result as { then?: unknown }).then).not.toBe("function");

    const registeredToolNames = registerTool.mock.calls
      .map(([, metadata]) => (metadata as { name?: string })?.name)
      .filter((name): name is string => typeof name === "string");
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

    expect(registerTool).toHaveBeenCalledTimes(expectedToolNames.length);
    expect(registeredToolNames).toEqual(expectedToolNames);
    expect(hookNames).toEqual([]);

    const memorySlot = (result as { plugins: { slots: { memory: unknown } } }).plugins.slots.memory as {
      search?: unknown;
      readFile?: unknown;
      status?: unknown;
    };
    expect(typeof memorySlot.search).toBe("function");
    expect(typeof memorySlot.readFile).toBe("function");
    expect(typeof memorySlot.status).toBe("function");
  });

  it("registers automation hooks when automation mode is explicitly enabled", () => {
    const hookNames: string[] = [];
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
        automationMode: true
      },
      registerTool,
      on: vi.fn((hookName: string) => {
        hookNames.push(hookName);
      })
    };

    clawvaultPlugin.register(api);

    expect(hookNames).toContain("before_prompt_build");
    expect(hookNames).toContain("message_sending");
    expect(hookNames).toContain("gateway_start");
    expect(hookNames).toContain("session_start");
    expect(hookNames).toContain("session_end");
    expect(hookNames).toContain("before_reset");
    expect(hookNames).toContain("before_compaction");
    expect(hookNames).toContain("agent_end");
  });

  it("registers automation hooks when legacy automation flags are enabled", () => {
    const hookNames: string[] = [];

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
        enableSessionContextInjection: true
      },
      registerTool: vi.fn(),
      on: vi.fn((hookName: string) => {
        hookNames.push(hookName);
      })
    };

    clawvaultPlugin.register(api);

    expect(hookNames).toContain("before_prompt_build");
    expect(hookNames).toContain("message_sending");
    expect(hookNames).toContain("gateway_start");
    expect(hookNames).toContain("session_start");
    expect(hookNames).toContain("session_end");
    expect(hookNames).toContain("before_reset");
    expect(hookNames).toContain("before_compaction");
    expect(hookNames).toContain("agent_end");
  });
});
