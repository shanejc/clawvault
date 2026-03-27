# OpenClaw Plugin Packs Migration Guide

This guide explains how legacy OpenClaw plugin boolean flags map to the newer pack presets/toggles model, and what compatibility behavior ClawVault guarantees during migration.

## Why this migration exists

The plugin now treats **packs** as the user-facing configuration model:

- `packPreset` chooses a default behavior profile (`thin`, `hybrid`, or `legacy`).
- `packToggles` allows per-pack opt-in/opt-out overrides.

Legacy booleans are still supported for backward compatibility, but they are now a low-level compatibility layer under the pack model.

## Preset behavior at a glance

| Preset (`packPreset`) | Enabled packs | Intended behavior |
| --- | --- | --- |
| `thin` (default/safest) | none | Manual-first mode. No autonomous lifecycle/observation side effects by default. |
| `hybrid` | `session-memory` | Enables session memory automation (recovery/context lifecycle behavior), while keeping observation/reflection/policy packs off. |
| `legacy` | `session-memory`, `capture-observation`, `reflection-maintenance`, `legacy-communication-policy` | Restores legacy-style automation behavior across memory lifecycle + observation/reflection + communication policy hooks. |

## Legacy boolean → pack mapping

If you already set legacy booleans, ClawVault maps them to pack activation so old configs keep working.

| Legacy boolean flag | Mapped pack | Notes |
| --- | --- | --- |
| `enableStartupRecovery` | `session-memory` | Startup recovery flow. |
| `enableSessionContextInjection` | `session-memory` | Session context injection flow. |
| `enableBeforePromptRecall` | `session-memory` | Before-prompt memory recall flow. |
| `enableAutoCheckpoint` | `capture-observation` | Auto-checkpoint lifecycle behavior. |
| `enableObserveOnNew` | `capture-observation` | Observation-on-new-session behavior. |
| `enableHeartbeatObservation` | `capture-observation` | Heartbeat-triggered observation behavior. |
| `enableCompactionObservation` | `capture-observation` | Compaction-time observation behavior. |
| `enableFactExtraction` | `capture-observation` | Fact extraction behavior in observation pipeline. |
| `autoCheckpoint` | `capture-observation` | Legacy alias for checkpoint automation. |
| `observeOnHeartbeat` | `capture-observation` | Legacy alias for heartbeat observation. |
| `enableWeeklyReflection` | `reflection-maintenance` | Weekly reflection maintenance behavior. |
| `weeklyReflection` | `reflection-maintenance` | Legacy alias for weekly reflection. |
| `enforceCommunicationProtocol` | `legacy-communication-policy` | Message protocol enforcement behavior. |
| `enableMessageSendingFilter` | `legacy-communication-policy` | Message send filter behavior. |

## Compatibility behavior guarantees

ClawVault preserves compatibility in these ways:

1. **Legacy booleans still work.**  
   Setting any mapped legacy boolean to `true` activates its owning pack behavior even if `packPreset` is not set.

2. **Explicit `packToggles` take precedence.**  
   If `packToggles.<pack>` is set to `true`/`false`, that explicit value wins.

3. **Feature booleans can still override individual features.**  
   Pack activation supplies default behavior, but explicit per-feature boolean settings continue to override those defaults.

4. **Preset switching is non-destructive.**  
   Changing `packPreset` does not erase existing `packToggles` or legacy booleans in config.

## Recommended migration path

1. Set a base preset:

```bash
clawvault openclaw preset thin
# or: hybrid / legacy
```

2. Keep existing booleans in place initially (safe transition).
3. Verify behavior.
4. Gradually replace per-feature booleans with `packPreset` + `packToggles` where possible.

## Configuration examples

### 1) Thin default (manual-first)

```bash
openclaw config set plugins.entries.clawvault.config.packPreset thin
```

### 2) Hybrid opt-in

```bash
openclaw config set plugins.entries.clawvault.config.packPreset hybrid
```

### 3) Legacy behavior opt-in

```bash
openclaw config set plugins.entries.clawvault.config.packPreset legacy
```

### 4) Fine-grained override with toggles

```bash
openclaw config set plugins.entries.clawvault.config.packPreset hybrid
openclaw config set plugins.entries.clawvault.config.packToggles.capture-observation true
```

