import { spawnSync } from "child_process";
import { isClawVaultPackPreset } from "./packs.js";

export const OPENCLAW_PLUGIN_CONFIG_ROOT = "plugins.entries.clawvault.config";
export const OPENCLAW_PACK_PRESET_CONFIG_KEY = "packPreset";
export const OPENCLAW_PACK_PRESET_CONFIG_PATH = `${OPENCLAW_PLUGIN_CONFIG_ROOT}.${OPENCLAW_PACK_PRESET_CONFIG_KEY}`;

export const FIRST_RUN_OPENCLAW_PRESETS = ["thin", "hybrid", "legacy"] as const;

export type FirstRunOpenClawPreset = (typeof FIRST_RUN_OPENCLAW_PRESETS)[number];

export interface OpenClawPresetInfo {
  mode: FirstRunOpenClawPreset;
  description: string;
  autonomousSideEffects: boolean;
}

const PRESET_INFO: Record<FirstRunOpenClawPreset, OpenClawPresetInfo> = {
  thin: {
    mode: "thin",
    description: "Tool-only substrate; no automatic lifecycle hooks are registered.",
    autonomousSideEffects: false
  },
  hybrid: {
    mode: "hybrid",
    description: "Enables session-memory lifecycle automation (context/recovery/autonomous session hooks).",
    autonomousSideEffects: true
  },
  legacy: {
    mode: "legacy",
    description: "Enables all legacy-compatible automation packs, including observation/reflection and message policy hooks.",
    autonomousSideEffects: true
  }
};

export interface ApplyOpenClawPresetResult {
  mode: FirstRunOpenClawPreset;
  configPath: string;
  command: string;
  changedOnlyPackPreset: true;
}

export function isFirstRunOpenClawPreset(value: unknown): value is FirstRunOpenClawPreset {
  return typeof value === "string" && (FIRST_RUN_OPENCLAW_PRESETS as readonly string[]).includes(value);
}

export function getOpenClawPresetInfo(mode: FirstRunOpenClawPreset): OpenClawPresetInfo {
  return PRESET_INFO[mode];
}

export function listOpenClawPresetInfo(): OpenClawPresetInfo[] {
  return FIRST_RUN_OPENCLAW_PRESETS.map((mode) => PRESET_INFO[mode]);
}

export function buildOpenClawPackPresetArgs(mode: FirstRunOpenClawPreset): string[] {
  return ["config", "set", OPENCLAW_PACK_PRESET_CONFIG_PATH, mode];
}

export function buildOpenClawReadPackPresetArgs(): string[] {
  return ["config", "get", OPENCLAW_PACK_PRESET_CONFIG_PATH];
}

export function readOpenClawPackPreset(): FirstRunOpenClawPreset | null {
  const args = buildOpenClawReadPackPresetArgs();
  const result = spawnSync("openclaw", args, { encoding: "utf8" });

  if (result.error) {
    throw new Error(`Failed to run openclaw config get: ${result.error.message}`);
  }

  if (typeof result.status === "number" && result.status !== 0) {
    return null;
  }

  if (result.signal) {
    throw new Error(`openclaw config get terminated by signal ${result.signal}`);
  }

  const value = String(result.stdout ?? "").trim();
  const normalized = value.replace(/^["']|["']$/g, "");
  return isFirstRunOpenClawPreset(normalized) ? normalized : null;
}

export function applyOpenClawPackPreset(mode: FirstRunOpenClawPreset): ApplyOpenClawPresetResult {
  if (!isFirstRunOpenClawPreset(mode)) {
    throw new Error(`Unsupported preset: ${String(mode)}. Expected one of: ${FIRST_RUN_OPENCLAW_PRESETS.join(", ")}`);
  }

  if (!isClawVaultPackPreset(mode)) {
    throw new Error(`Preset ${mode} is not a valid ClawVault packPreset value.`);
  }

  const args = buildOpenClawPackPresetArgs(mode);
  const result = spawnSync("openclaw", args, { stdio: "inherit" });

  if (result.error) {
    throw new Error(`Failed to run openclaw config set: ${result.error.message}`);
  }

  if (typeof result.status === "number" && result.status !== 0) {
    throw new Error(`openclaw config set exited with code ${result.status}`);
  }

  if (result.signal) {
    throw new Error(`openclaw config set terminated by signal ${result.signal}`);
  }

  return {
    mode,
    configPath: OPENCLAW_PACK_PRESET_CONFIG_PATH,
    command: `openclaw ${args.join(" ")}`,
    changedOnlyPackPreset: true
  };
}
