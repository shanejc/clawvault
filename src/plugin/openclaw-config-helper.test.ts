import { describe, expect, it } from "vitest";
import {
  FIRST_RUN_OPENCLAW_PRESETS,
  OPENCLAW_PACK_PRESET_CONFIG_PATH,
  buildOpenClawPackPresetArgs,
  getOpenClawPresetInfo,
  isFirstRunOpenClawPreset,
  listOpenClawPresetInfo
} from "./openclaw-config-helper.js";

describe("openclaw pack preset helper", () => {
  it("uses the canonical OpenClaw plugin config path", () => {
    expect(OPENCLAW_PACK_PRESET_CONFIG_PATH).toBe("plugins.entries.clawvault.config.packPreset");
  });

  it.each(FIRST_RUN_OPENCLAW_PRESETS)("builds config args for %s", (mode) => {
    expect(buildOpenClawPackPresetArgs(mode)).toEqual([
      "config",
      "set",
      "plugins.entries.clawvault.config.packPreset",
      mode
    ]);
  });

  it("marks autonomous side effects for non-thin presets", () => {
    expect(getOpenClawPresetInfo("thin").autonomousSideEffects).toBe(false);
    expect(getOpenClawPresetInfo("hybrid").autonomousSideEffects).toBe(true);
    expect(getOpenClawPresetInfo("legacy").autonomousSideEffects).toBe(true);
  });

  it("lists exactly first-run presets", () => {
    expect(listOpenClawPresetInfo().map((entry) => entry.mode)).toEqual(["thin", "hybrid", "legacy"]);
  });

  it("validates supported first-run presets", () => {
    expect(isFirstRunOpenClawPreset("thin")).toBe(true);
    expect(isFirstRunOpenClawPreset("automation")).toBe(false);
    expect(isFirstRunOpenClawPreset("bad")).toBe(false);
  });
});
