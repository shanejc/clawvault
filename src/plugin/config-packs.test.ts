import { describe, expect, it } from "vitest";
import { getPackBehaviorMode, getPackCallbackPolicy, isFeatureEnabled, isPackEnabled } from "./config.js";
import type { ClawVaultPluginConfig } from "./config.js";

/*
Expected preset pack matrix (keep in sync with src/plugin/packs.ts):
| preset | session-memory | capture-observation | reflection-maintenance | legacy-communication-policy |
| --- | --- | --- | --- | --- |
| thin | off | off | off | off |
| hybrid | on | off | off | off |
| legacy | on | on | on | on |
*/

describe("pack-aware config behavior", () => {
  it.each([
    {
      preset: "thin",
      expected: {
        "session-memory": false,
        "capture-observation": false,
        "reflection-maintenance": false,
        "legacy-communication-policy": false
      }
    },
    {
      preset: "hybrid",
      expected: {
        "session-memory": true,
        "capture-observation": false,
        "reflection-maintenance": false,
        "legacy-communication-policy": false
      }
    },
    {
      preset: "legacy",
      expected: {
        "session-memory": true,
        "capture-observation": true,
        "reflection-maintenance": true,
        "legacy-communication-policy": true
      }
    }
  ] as const)("enables expected packs for $preset preset", ({ preset, expected }) => {
    const config: ClawVaultPluginConfig = { packPreset: preset };

    expect(isPackEnabled(config, "session-memory")).toBe(expected["session-memory"]);
    expect(isPackEnabled(config, "capture-observation")).toBe(expected["capture-observation"]);
    expect(isPackEnabled(config, "reflection-maintenance")).toBe(expected["reflection-maintenance"]);
    expect(isPackEnabled(config, "legacy-communication-policy")).toBe(expected["legacy-communication-policy"]);
  });

  it("does not map a single legacy feature boolean to sibling feature activation", () => {
    const config: ClawVaultPluginConfig = { enableStartupRecovery: true };

    expect(isFeatureEnabled(config, "enableStartupRecovery", false)).toBe(true);
    expect(isFeatureEnabled(config, "enableSessionContextInjection", false)).toBe(false);
    expect(isPackEnabled(config, "session-memory")).toBe(false);
  });

  it("keeps mixed legacy flags isolated across packs", () => {
    const config: ClawVaultPluginConfig = {
      enableObserveOnNew: true,
      enableWeeklyReflection: false
    };

    expect(isFeatureEnabled(config, "enableObserveOnNew", false)).toBe(true);
    expect(isFeatureEnabled(config, "enableAutoCheckpoint", false)).toBe(false);
    expect(isFeatureEnabled(config, "enableWeeklyReflection", true)).toBe(false);
    expect(isFeatureEnabled(config, "weeklyReflection", false)).toBe(false);
  });

  it("supports automationMode as a global pack opt-in fallback", () => {
    const config: ClawVaultPluginConfig = { automationMode: true };

    expect(isPackEnabled(config, "session-memory")).toBe(true);
    expect(isPackEnabled(config, "capture-observation")).toBe(true);
    expect(isPackEnabled(config, "reflection-maintenance")).toBe(true);
    expect(isPackEnabled(config, "legacy-communication-policy")).toBe(true);
  });

  it("supports explicit memoryBehaviorDomains mode overrides, including callback", () => {
    const config: ClawVaultPluginConfig = {
      packPreset: "thin",
      memoryBehaviorDomains: {
        "session-memory": "callback"
      }
    };

    expect(getPackBehaviorMode(config, "session-memory")).toBe("callback");
    expect(isPackEnabled(config, "session-memory")).toBe(true);
    expect(getPackBehaviorMode(config, "capture-observation")).toBe("off");
  });

  it("prefers explicit per-domain mode over preset defaults and pack toggles", () => {
    const config: ClawVaultPluginConfig = {
      packPreset: "hybrid",
      packToggles: {
        "session-memory": true
      },
      memoryBehaviorDomains: {
        "session-memory": "off",
        "capture-observation": "callback"
      }
    };

    expect(getPackBehaviorMode(config, "session-memory")).toBe("off");
    expect(isPackEnabled(config, "session-memory")).toBe(false);
    expect(getPackBehaviorMode(config, "capture-observation")).toBe("callback");
    expect(isPackEnabled(config, "capture-observation")).toBe(true);
  });

  it("uses pack activation for feature defaults while honoring explicit boolean overrides", () => {
    const config: ClawVaultPluginConfig = {
      packToggles: {
        "legacy-communication-policy": true
      },
      enableMessageSendingFilter: false
    };

    expect(isFeatureEnabled(config, "enforceCommunicationProtocol", false)).toBe(true);
    expect(isFeatureEnabled(config, "enableMessageSendingFilter", true)).toBe(false);
  });

  it("keeps strict recall mandate as explicit opt-in even when session-memory pack is enabled", () => {
    const config: ClawVaultPluginConfig = { packPreset: "hybrid" };

    expect(isFeatureEnabled(config, "enableBeforePromptRecall", false)).toBe(true);
    expect(isFeatureEnabled(config, "enableStrictBeforePromptRecall", false)).toBe(false);
  });

  it("resolves callback policy from global and per-pack overrides", () => {
    const config: ClawVaultPluginConfig = {
      memoryBehaviorCallbackPolicy: "fallbackToAuto",
      memoryBehaviorCallbackPolicies: {
        "capture-observation": "hardFail"
      }
    };

    expect(getPackCallbackPolicy(config, "session-memory")).toBe("fallbackToAuto");
    expect(getPackCallbackPolicy(config, "capture-observation")).toBe("hardFail");
    expect(getPackCallbackPolicy({}, "legacy-communication-policy")).toBe("legacy");
  });
});
