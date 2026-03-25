export const CLAWVAULT_PACK_NAMES = [
  "session-memory",
  "capture-observation",
  "reflection-maintenance",
  "legacy-communication-policy"
] as const;

export type ClawVaultAutomationPack = (typeof CLAWVAULT_PACK_NAMES)[number];
export type ClawVaultPackPreset = "thin" | "hybrid" | "legacy" | "automation";

export type ClawVaultPackToggleMap = Partial<Record<ClawVaultAutomationPack, boolean>>;

export const PACK_PRESET_TOGGLES: Record<ClawVaultPackPreset, ClawVaultPackToggleMap> = {
  thin: {},
  hybrid: {
    "session-memory": true
  },
  legacy: {
    "session-memory": true,
    "capture-observation": true,
    "reflection-maintenance": true,
    "legacy-communication-policy": true
  },
  automation: {
    "session-memory": true,
    "capture-observation": true,
    "reflection-maintenance": true,
    "legacy-communication-policy": true
  }
};

export const PACK_FEATURE_KEYS: Record<ClawVaultAutomationPack, readonly string[]> = {
  "session-memory": [
    "enableStartupRecovery",
    "enableSessionContextInjection",
    "enableBeforePromptRecall"
  ],
  "capture-observation": [
    "enableAutoCheckpoint",
    "enableObserveOnNew",
    "enableHeartbeatObservation",
    "enableCompactionObservation",
    "enableFactExtraction",
    "autoCheckpoint",
    "observeOnHeartbeat"
  ],
  "reflection-maintenance": [
    "enableWeeklyReflection",
    "weeklyReflection"
  ],
  "legacy-communication-policy": [
    "enforceCommunicationProtocol",
    "enableMessageSendingFilter"
  ]
};

export function isClawVaultPackName(value: unknown): value is ClawVaultAutomationPack {
  return typeof value === "string" && (CLAWVAULT_PACK_NAMES as readonly string[]).includes(value);
}
