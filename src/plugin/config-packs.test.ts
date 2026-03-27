import { describe, expect, it } from "vitest";
import { isFeatureEnabled, isPackEnabled } from "./config.js";
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

  it("maps legacy feature booleans to pack activation", () => {
    const config: ClawVaultPluginConfig = { enableObserveOnNew: true };

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
});
