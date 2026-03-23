# ClawVault OpenClaw Plugin Architecture

## Purpose

This document defines the target architecture for the ClawVault OpenClaw plugin.

The plugin should evolve into a **thin-by-default memory substrate** for OpenClaw agents:

- local-first by default
- narrow and auditable
- capable of reading and writing the memory system intentionally
- supportive of AGENTS/OpenClaw orchestration rather than competitive with it

It exists to serve the memory model defined at the project root, not to replace that model with a second policy engine.

---

## Current Branch Baseline

This architecture is a refactor plan for the plugin as it exists on this branch today, not a greenfield design.

Current implementation characteristics to preserve or account for:

- synchronous OpenClaw plugin registration
- existing OpenClaw tools for retrieval (`memory_search`, `memory_get`)
- legacy slot compatibility for non-OpenClaw runtimes
- current hook-based lifecycle integration
- existing lower-level capabilities already present under the surface, such as slot `search`, `recall`, `capture`, and `store`
- existing configuration flags and defaults, even where those defaults will change

This document should therefore be read as:

1. a description of the desired target architecture
2. a map of what stays
3. a map of what moves behind feature packs
4. a delta from the current branch behavior to the target behavior

---

## Hard Rule

**The plugin may automate memory operations, but it must not own memory policy.**

Meaning:

- the plugin may expose tools, storage primitives, lifecycle signals, and optional automation
- `AGENTS.md` and OpenClaw agent prompts remain the owners of recall/writeback policy
- the plugin must not become a second constitution that overrides the memory model through hidden prompt logic or broad automatic behavior

---

## Architectural Goals

1. Preserve the three-layer memory model:
   - `MEMORY.md` = boot / reflex memory
   - vault notes = durable long-term memory
   - raw/source files = chronology and evidence
2. Make the plugin useful in a thin, agent-driven mode first.
3. Keep current built-in automation available where practical, but disable it by default.
4. Support an onboarding/setup flow that helps the user choose which optional behaviors to enable.
5. Keep durable retrieval and writeback local-first and explicit.
6. Treat the vault as authoritative for durable knowledge, with `MEMORY.md` as a curated boot cache.

---

## Non-Goals

The default plugin should not:

- act like a transcript dump pipeline
- own the whole behavioral runtime of the agent
- silently rewrite broad communication policy into every prompt
- depend on cloud services by default
- force users into legacy hook-heavy behavior

Legacy/compat behavior may continue to exist as an opt-in feature pack, but it is not the design center.

---

## Operating Modes / Presets

The plugin should support preset-based operation instead of exposing only a bag of unrelated booleans.

### 1. Thin / Agent-Driven (default)

Enabled by default:

- vault discovery / routing
- retrieval tools
- writeback tools
- category registry
- provenance-aware reads/writes
- minimal lifecycle signals if needed

Disabled by default:

- prompt rewriting
- communication-style enforcement
- broad automatic maintenance behavior
- autonomous reflection / observation / checkpoint orchestration

### 2. Hybrid

A middle path for users who want some assistance without the full legacy behavior.

May include:

- optional context injection
- optional recovery notices
- optional maintenance assists
- optional boot-memory refresh helpers

### 3. Legacy Automation

Compatibility mode for users who want the pre-refactor behavior.

May include:

- recall mandates injected into prompts
- message-sending filtering / rewrites
- broader lifecycle-triggered automation
- old defaults preserved as a feature pack

This mode should remain available only if it can be isolated cleanly from the core substrate.

---

## Core Module Boundaries

The refactor should separate the plugin into explicit layers.

### A. Core Memory Substrate

Responsibilities:

- resolve the correct vault for an agent/session
- expose retrieval and writeback tools
- enforce safe path/category rules
- attach provenance and citations
- provide layer-aware memory metadata

This layer is the architectural center.

### B. Boot Memory Subsystem

Responsibilities:

- read and update `MEMORY.md`
- enforce section-aware writes
- keep boot memory concise and curated
- support refresh-from-vault style workflows

### C. Optional Feature Packs

Responsibilities:

- provide opt-in automation
- group related legacy behavior coherently
- remain detachable from the core substrate

Suggested packs:

- recall/context pack
- maintenance pack
- legacy protocol pack

### D. Onboarding / Config UX

Responsibilities:

- let users choose presets
- configure vault routing
- configure categories
- configure boot-memory behavior
- make optional automation discoverable without making it the default

---

## Memory Layer Contract

The plugin must model the memory system as explicit layers.

### Boot Layer

**Location:** `MEMORY.md`

Use for:

- identity
- stable preferences
- must-know operating assumptions
- active frontier context required on boot

Constraints:

- lean
- curated
- summary-oriented
- not a history dump

### Durable Layer

**Location:** structured vault notes

Includes native folders such as:

- `people/`
- `projects/`
- `decisions/`
- `lessons/`
- `tasks/`
- `backlog/`
- `handoffs/`

And additive overlay/custom folders such as:

- `systems/`
- `meetings/`
- `sources/`
- `imports/`
- `reports/`
- onboarding-configured custom categories

Constraints:

- structured
- durable
- source-aware
- reviewable
- authoritative for long-term memory

### Source Layer

Examples:

- `memory/YYYY-MM-DD.md`
- `memory/chat-*.md`
- imported transcripts
- raw chronology/evidence captures

Constraints:

- available for later distillation
- not the primary durable memory layer
- not the primary recall layer by default

### Retrieval Requirement

The plugin must treat durable vault notes as first-class retrievable memory.

That means:

- search results must distinguish `boot`, `vault`, and `source` layers
- read APIs must support durable vault notes, not only `MEMORY.md` or source files
- citations/provenance must remain available across all layers

---

## Tool Surface

The plugin should expose the full memory workflow as tools, not just search.

### Retrieval Tools

- `memory_search`
- `memory_get`
- `memory_categories`

### Writeback Tools

- `memory_classify`
- `memory_write_vault`
- `memory_write_boot`
- `memory_capture_source`
- `memory_update` / `memory_patch` (if needed for note mutation workflows)

### Tool Intent

#### `memory_classify`

Input:

- distilled candidate memory
- optional source/provenance metadata

Output:

- layer suggestion: `boot`, `vault`, `source`, or `discard`
- category suggestion for durable writes
- rationale / confidence metadata where helpful

#### `memory_write_vault`

Writes durable memory into the correct vault category.

Requirements:

- provenance-aware
- category-aware
- safe and deterministic

#### `memory_write_boot`

Writes to `MEMORY.md` using section-aware direct update rules.

Requirements:

- no blind append
- no full-file overwrite unless explicitly requested
- preserve unrelated sections
- maintain concise boot memory

#### `memory_capture_source`

Stores chronology/evidence without promoting it into durable memory by default.

#### `memory_categories`

Returns:

- protected native categories
- additive overlay categories
- onboarding-configured custom categories
- the layer/category mapping rules the plugin is using

---

## `MEMORY.md` Contract

The plugin should treat `MEMORY.md` as a special managed surface, not as an ordinary note file.

### Default Sections

A reasonable default shape is:

- `Identity`
- `Key Decisions`
- `Current Focus`
- `Constraints / Preferences`
- `Quick Links`

This should remain configurable, but the plugin should ship with a clear default schema.

### Write Semantics

The desired contract is **section-aware direct update**.

That means:

- writes target a named section
- entries are merged or replaced deterministically
- duplicates are removed where practical
- unrelated sections are preserved
- large or obviously durable details should be redirected into the vault instead of being stuffed into boot memory

### Authority Rule

- the vault is authoritative for durable memory
- `MEMORY.md` is an executive summary / boot cache
- `MEMORY.md` should reference the vault rather than duplicate the vault in detail

### Boot-Memory Refresh Helpers

The plugin may optionally support:

- refresh suggestions based on vault state
- periodic boot-memory cleanup helpers
- generated summaries that can be applied section-by-section

These helpers must still respect the concise boot-memory contract.

---

## Category Model

The plugin should support both stability and extensibility.

### Protected Native Categories

These categories are semantically important and should not be casually repurposed:

- `people`
- `projects`
- `decisions`
- `lessons`
- `tasks`
- `backlog`
- `handoffs`
- and any other ClawVault-native operational folders proven to be first-class

### Additive Overlay / Custom Categories

Users should be able to add categories without fighting the plugin, such as:

- `systems`
- `meetings`
- `sources`
- `imports`
- `reports`
- onboarding-defined custom categories

### Rule

Overlay, don’t overthrow.

The plugin should preserve native operational meaning while allowing additive customization.

---

## Optional Feature Packs

Feature packs should make existing automation preservable without forcing it on everyone.

### Recall / Context Pack

May include:

- before-prompt recall hints
- session context injection
- recovery notices

### Maintenance Pack

May include:

- startup recovery
- auto-checkpoint
- observation triggers
- reflection scheduling
- fact extraction helpers

### Legacy Protocol Pack

May include:

- communication-protocol appendices
- message rewriting / filtering
- other pre-refactor prompt-governance behavior

### Pack Rule

Feature packs:

- must be explicit
- must be disableable
- must not be required for the thin default mode
- must not blur the boundary between substrate and policy

---

## Onboarding / Setup Flow

The plugin should eventually offer a setup flow that asks the user to choose:

1. operating mode / preset
2. single-vault or per-agent routing
3. boot-memory handling style
4. native-only vs additive categories
5. which optional feature packs to enable

The output of onboarding should be concrete plugin config, not just advice.

---

## Documentation Reference Position

`docs/openclaw-plugin-usage.md` should be treated as a useful behavioral reference for the target model, especially for:

- `MEMORY.md` vs vault framing
- vault-authoritative / boot-cache distinction
- hybrid operation concepts
- keeping `MEMORY.md` lean

However, stale installation and hook-pack assumptions in older docs should not be treated as normative architecture.

---

## Refactor Delta From Current Implementation

The current branch already contains useful building blocks. The job is to refactor them into the target architecture rather than discard them blindly.

### Keep

- synchronous registration and runtime compatibility behavior
- existing retrieval entry points where they fit the model
- existing slot-level memory capabilities that can be promoted into first-class tools
- vault routing and agent/session-aware resolution logic

### Rework

- retrieval metadata so durable vault notes are first-class and layer-aware
- `memory_get` scope so it can read durable vault notes safely, not only `MEMORY.md` and source files
- current defaults so thin / agent-driven mode becomes the default preset
- docs and compatibility checks that still assume the older hook-pack layout

### Move Behind Optional Packs

- prompt recall mandates
- communication-style / protocol rewriting
- broad lifecycle-triggered maintenance automation
- reflection / observation / checkpoint conveniences that are helpful but not core substrate behavior

### Add

- explicit writeback tools
- structured `MEMORY.md` section-aware update support
- category registry / custom category support
- onboarding/preset setup flow
- a clearer distinction between substrate behavior and agent policy

This section exists to keep implementation work grounded in the code that is already here on the branch.

---

## Migration Strategy

The refactor should be staged.

1. Define the architecture and module boundaries.
2. Make retrieval layer-aware.
3. Expose the writeback tool surface.
4. Add structured `MEMORY.md` support.
5. Add additive category support.
6. Move current behavior behind feature packs / presets.
7. Add onboarding/setup.
8. Realign docs and compatibility checks.

Where practical:

- preserve existing behavior behind compatibility mode
- flip the default to thin / agent-driven
- avoid a hard fork unless the current codebase proves impossible to modularize cleanly

---

## Success Criteria

The architecture is succeeding if:

- the plugin is useful in thin mode
- durable vault notes are first-class memory in retrieval and writeback
- `MEMORY.md` becomes easier to keep curated
- optional automation remains available without becoming mandatory
- the plugin feels like a substrate and adapter, not a second hidden policy engine
- OpenClaw agents remain the preferred place for higher-level reflection and maintenance decisions
