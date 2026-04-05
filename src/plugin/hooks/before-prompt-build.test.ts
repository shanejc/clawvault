import { describe, expect, it } from "vitest";
import { createBeforePromptBuildHandler } from "./before-prompt-build.js";
import { ClawVaultPluginRuntimeState } from "../runtime-state.js";

describe("before_prompt_build hook", () => {
  it("uses advisory recall guidance for hybrid-style recall, plus recovery/session context and vault injection", async () => {
    const runtimeState = new ClawVaultPluginRuntimeState();
    runtimeState.setStartupRecoveryNotice("Recovered context from last interrupted run.");
    runtimeState.setSessionRecap("agent:main:direct", "Session recap: user asked for deployment notes.");

    const handler = createBeforePromptBuildHandler({
      pluginConfig: {
        enableBeforePromptRecall: true,
        enforceCommunicationProtocol: true,
        enableSessionContextInjection: true
      },
      runtimeState,
      contextInjector: async () => ({
        prependSystemContext: "Relevant memories:\n- release cutover uses phased waves.",
        memoryEntries: [],
        recapEntries: [],
        vaultPath: "/tmp/vault"
      })
    });

    const result = await handler(
      { prompt: "what did we decide about release?", messages: [] },
      { sessionKey: "agent:main:direct", agentId: "main" }
    );

    expect(result?.prependSystemContext).toContain("ClawVault Memory Recall Guidance");
    expect(result?.prependSystemContext).not.toContain("ClawVault Memory Recall Policy (Strict)");
    expect(result?.prependSystemContext).toContain("Recovered context");
    expect(result?.prependSystemContext).toContain("Session recap");
    expect(result?.prependSystemContext).toContain("Relevant memories");
    expect(result?.appendSystemContext).toContain("ClawVault Communication Protocol");
  });

  it("prepends strict recall mandate only when explicit strict flag is enabled", async () => {
    const runtimeState = new ClawVaultPluginRuntimeState();
    const handler = createBeforePromptBuildHandler({
      pluginConfig: {
        enableBeforePromptRecall: true,
        enableStrictBeforePromptRecall: true,
        enableSessionContextInjection: false
      },
      runtimeState
    });

    const result = await handler(
      { prompt: "summarize last sprint decisions", messages: [] },
      { sessionKey: "agent:main:direct", agentId: "main" }
    );

    expect(result?.prependSystemContext).toContain("ClawVault Memory Recall Policy (Strict)");
    expect(result?.prependSystemContext).not.toContain("ClawVault Memory Recall Guidance");
  });

  it("returns void when no injection and protocol disabled", async () => {
    const runtimeState = new ClawVaultPluginRuntimeState();
    const handler = createBeforePromptBuildHandler({
      pluginConfig: {
        enableBeforePromptRecall: false,
        enforceCommunicationProtocol: false,
        enableSessionContextInjection: false
      },
      runtimeState,
      contextInjector: async () => ({
        prependSystemContext: "",
        memoryEntries: [],
        recapEntries: [],
        vaultPath: null
      })
    });

    const result = await handler(
      { prompt: "hello", messages: [] },
      { sessionKey: "agent:main:direct", agentId: "main" }
    );
    expect(result).toBeUndefined();
  });

  it("skips recall policy and context injection for non-continuity prompts", async () => {
    const runtimeState = new ClawVaultPluginRuntimeState();
    let injectorCalls = 0;
    const handler = createBeforePromptBuildHandler({
      pluginConfig: {
        enableBeforePromptRecall: true,
        enforceCommunicationProtocol: false,
        enableSessionContextInjection: true
      },
      runtimeState,
      contextInjector: async () => {
        injectorCalls++;
        return {
          prependSystemContext: "should not be injected",
          memoryEntries: [],
          recapEntries: [],
          vaultPath: null
        };
      }
    });

    const result = await handler(
      {
        prompt: "Write a haiku about coffee.",
        messages: [{ role: "user", content: "Write a haiku about coffee." }]
      },
      { sessionKey: "agent:main:direct", agentId: "main" }
    );

    expect(injectorCalls).toBe(0);
    expect(result).toBeUndefined();
  });

  it("refreshes recall using latest user correction and replaces prior injected context", async () => {
    const runtimeState = new ClawVaultPluginRuntimeState();
    let seenPrompt = "";
    const handler = createBeforePromptBuildHandler({
      pluginConfig: {
        enableBeforePromptRecall: true,
        enforceCommunicationProtocol: false,
        enableSessionContextInjection: true
      },
      runtimeState,
      contextInjector: async (input) => {
        seenPrompt = input.prompt;
        return {
          prependSystemContext: "Relevant memories:\n- Tuesday meeting note.",
          memoryEntries: [],
          recapEntries: [],
          vaultPath: "/tmp/vault"
        };
      }
    });

    const result = await handler(
      {
        prompt: "No, I was really talking about the meeting on Tuesday.",
        messages: [
          { role: "assistant", content: "I found the Thursday note." },
          { role: "user", content: "No, I was really talking about the meeting on Tuesday." }
        ]
      },
      { sessionKey: "agent:main:direct", agentId: "main" }
    );

    expect(seenPrompt).toContain("meeting on Tuesday");
    expect(result?.prependSystemContext).toContain("Tuesday meeting note");
  });
});
