import { describe, expect, it } from "vitest";
import { isFeatureEnabled, isPackEnabled } from "./config.js";
import type { ClawVaultPluginConfig } from "./config.js";

describe("pack-aware config behavior", () => {
  it("enables packs from presets", () => {
    const config: ClawVaultPluginConfig = { packPreset: "hybrid" };

    expect(isPackEnabled(config, "session-memory")).toBe(true);
    expect(isPackEnabled(config, "capture-observation")).toBe(false);
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
