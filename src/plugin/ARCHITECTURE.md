# Plugin Architecture

## Purpose

This document defines the intended architecture for the ClawVault plugin as a three-layer system:

1. **Core memory substrate**
2. **Optional automation packs**
3. **Onboarding/config UX**

The goal is to keep the plugin useful in a minimal, agent-driven mode while preserving a compatibility path for users who want legacy automation behavior.

---

## Design goals

### 1) Stable substrate first

The plugin must always provide a reliable memory substrate that works even when every automation feature is disabled.

### 2) Local-first by default

The default experience should read from and write to a local ClawVault vault under user control. The plugin should not require hosted services, prompt relays, or cloud policy engines in order to function.

### 3) Agent policy stays outside the substrate

Behavioral rules for AGENTS/OpenClaw agents should not be hard-coded into the base substrate. The substrate exposes memory capabilities; agent policy decides how and when to use them.

**Hard rule:** “The plugin may automate memory operations, but it must not own memory policy.”

### 4) No hidden autonomy in the base layer

Autonomous observation, checkpointing, reflection, fact extraction, or message rewriting must not be part of the mandatory core. Those belong in optional automation packs.

### 5) Legacy compatibility without legacy defaults

Existing users who depend on automatic hooks and policy-like behaviors must still be able to enable them. However, those behaviors should be grouped behind explicit opt-in configuration or onboarding presets.

---

## Layer 1: Core memory substrate

### Definition

The **core memory substrate** is the always-available integration layer between OpenClaw and a local ClawVault vault. It provides safe, explicit memory primitives and vault discovery, but it does **not** impose autonomous behavior on the agent.

### Required properties

- **Always available** once the plugin is installed.
- **Local-first** and centered on a user-controlled local vault.
- **No prompt rewriting** as a default capability.
- **No autonomous policy** or hidden background decision-making.
- **Explicit invocation model**: the agent or host asks for memory operations directly.

### What belongs in the substrate

#### Vault resolution and configuration plumbing

The substrate owns:

- locating the active vault for the current agent/session/workspace
- validating configured vault paths
- resolving per-agent vault mappings
- enforcing safe access to local configuration and executable settings

This is the foundational connectivity layer between the plugin runtime and the vault.

#### Explicit memory read primitives

The substrate should expose a required memory tool surface:

- `memory_search`
- `memory_get`
- `memory_categories`
- `memory_classify`

These are capabilities, not policies. The substrate returns memory data; it does not decide when the agent must consult memory.

#### Explicit memory write primitives

The substrate should expose explicit write/capture operations:

- `memory_write_vault`
- `memory_write_boot`
- `memory_capture_source`

Again, the key constraint is explicitness. A write should happen because the caller requested it, not because the substrate inferred a policy trigger.

#### Memory-layer contract (layer-aware)

The substrate contract is explicitly three-layered:

- **Boot** (`MEMORY.md`)
- **Durable** (structured vault notes)
- **Source** (chronology, evidence, and raw captures)

Durable notes are first-class in retrieval and writeback semantics. The substrate must treat durable notes as canonical long-lived memory objects, not as a secondary cache behind boot/source artifacts.

`MEMORY.md` semantics must require:

- section-aware direct updates
- no blind append by default
- preserving unrelated sections
- concise curated boot memory

#### Category model contract

Category handling must support:

- protected native categories
- additive custom/overlay categories
- an “overlay, don't overthrow” rule for extension behavior

Custom categories may extend classification and retrieval ergonomics, but they must not silently replace native category semantics required by the substrate.

#### Safety and integrity boundaries

The substrate should also own cross-cutting concerns required for safe operation:

- executable path verification and integrity checks
- argument sanitization
- session/agent identifier sanitization
- bounded output formatting for injected or returned context

These are infrastructure responsibilities, not automation behaviors.

### What does **not** belong in the substrate

The substrate must not, by default:

- rewrite prompts
- rewrite outbound messages
- automatically checkpoint sessions
- automatically observe conversations
- automatically extract facts
- automatically run reflections
- automatically recover and inject prior state
- enforce communication etiquette or behavioral policy

Those behaviors are useful, but they are not part of the minimal memory substrate.

### Substrate mental model

A helpful test is:

> If an agent author wants a completely agent-driven workflow where the model decides when to read or write memory, the substrate should still be fully usable without enabling any automation hooks.

That is the baseline architecture target.

---

## Layer 2: Optional automation packs

### Definition

**Optional automation packs** are named bundles of higher-level plugin behaviors built on top of the substrate. They preserve legacy-compatible workflows, but are disabled by default unless the user explicitly chooses them.

### Required properties

- **Legacy-compatible** with the current hook-driven plugin behavior.
- **Disabled by default** in a fresh minimal install.
- **Explicitly enabled** via config, onboarding, or preset selection.
- Built entirely **on top of** the core substrate.

### Why automation packs exist

The current plugin includes several behaviors that are valuable for users who want a more managed memory system:

- automatic context injection
- startup recovery notices
- auto-checkpointing
- observer triggers
- fact extraction
- weekly reflection
- communication protocol appendices
- outbound message rewriting and filtering

These should remain available, but as opt-in packs rather than mandatory substrate behavior.

### Pack structure

Automation packs should be organized around coherent user intent rather than isolated booleans only.

Recommended conceptual packs:

#### A. Session memory pack

Focus: automatically bringing relevant memory into a session.

Includes behaviors such as:

- session-start recap loading
- startup recovery notice generation
- before-prompt context injection
- recall reminders or helper instructions

This pack improves continuity, but it is still automation because it changes the runtime context without requiring explicit per-turn user requests.

#### B. Capture and observation pack

Focus: automatically converting agent activity into stored memory.

Includes behaviors such as:

- observe-on-new / observe-on-reset
- heartbeat observation
- compaction-time observation
- automatic fact extraction during lifecycle hooks
- auto-checkpointing before reset or similar lifecycle transitions

This pack adds memory capture automation and should remain opt-in.

#### C. Reflection and maintenance pack

Focus: periodic higher-order memory processing.

Includes behaviors such as:

- weekly reflection runs
- scheduled summarization or promotion workflows
- future maintenance jobs built on the same substrate

These are clearly beyond the substrate because they embody autonomous processing policies.

**Current hook entry points and mode semantics**

Reflection-maintenance behavior is wired through lifecycle hooks in the OpenClaw plugin layer:

- `gateway_start`
- `session_start`
- `session_end`
- `before_reset`

Mode behavior:

- `off`: no reflection-maintenance hook activity.
- `auto`: built-in lifecycle handlers run; weekly reflection checks are currently triggered via `session_start`.
- `callback`: host callback decides orchestration through explicit structured outcomes, not policy text parsing.

Callback orchestration outcomes for reflection/distillation:

- `local_run_approved`: run local lifecycle fallback and record orchestration event.
- `delegated_event`: do not run local fallback; emit orchestration event for external handling.
- `queued_for_approval`: do not run local fallback; emit orchestration event for approval queueing.
- `skipped`: explicit no-op outcome (also default when omitted).

#### D. Legacy communication policy pack

Focus: preserving older policy-shaped plugin behavior for teams that want it.

Includes behaviors such as:

- communication protocol appendix injection
- message sending filters
- outbound message rewriting
- question rewriting with memory evidence
- canceling outbound messages that fail pack rules

This pack is the clearest example of behavior that should **not** be in the base layer, because it approaches agent policy enforcement.

### Relationship to legacy config flags

The existing fine-grained flags can remain for backward compatibility, but the architecture should treat them as implementation details underneath pack-level controls.

That means:

- old configs continue to work
- pack presets can expand into the equivalent flag set
- documentation should describe packs first, raw booleans second

In other words, packs are the user-facing architecture; booleans are the low-level compatibility layer.

---

## Layer 3: Onboarding/config UX

### Definition

The **onboarding/config UX** is the layer that helps users choose how much automation they want. It must make the layer split understandable on first run, rather than dropping users into a large undifferentiated set of booleans.

### Required properties

- **First-run feature selection**
- clear explanation of substrate vs automation
- reversible choices
- presets for common usage patterns

### First-run experience

On first run, the plugin should explain:

1. the plugin can operate as a thin local memory substrate
2. automation is optional
3. legacy-style behavior is available as an opt-in preset

The setup flow should then ask the user which operating mode they want.

**Registration trigger detail (implementation contract):**

- First-run selection is considered **missing** when both `pluginConfig.packPreset` and `pluginConfig.automationPreset` are unset during plugin registration.
- When missing, registration emits a one-time setup prompt directing users to run `clawvault openclaw onboard`.
- A runtime marker suppresses repeated prompts/events for the same plugin runtime process.

### Presets

#### Thin / Agent-driven

Recommended for users who want the memory system but do not want the plugin to steer agent behavior.

Enables:

- vault selection / local vault setup
- explicit memory tools and substrate connectivity

Disables:

- automatic context injection
- automatic checkpointing
- automated observation
- reflection jobs
- message rewriting
- communication-policy appendices

This should be the cleanest representation of the architecture's default philosophy.

#### Hybrid

Recommended for users who want memory assistance without full legacy automation.

Enables a curated subset such as:

- session recap/context injection
- startup recovery notice
- optional gentle recall assistance

Keeps disabled unless separately chosen:

- aggressive observation hooks
- automated checkpointing
- outbound message rewriting/filtering
- full legacy communication policy enforcement

This preset gives practical convenience while still avoiding strong policy coupling.

#### Legacy automation

Recommended for users migrating from the current plugin behavior or wanting the previous managed experience.

Enables most or all legacy-compatible packs, including:

- session memory automation
- capture/observation automation
- reflection/maintenance automation
- communication-policy automation

This preset should be presented as compatible and familiar, but explicitly not the default.

### UX principles

The configuration UX should:

- describe behavior in plain language, not only internal flag names
- show which layer each feature belongs to
- allow pack-level toggles plus advanced per-feature overrides
- make it obvious when a behavior can rewrite prompts or messages
- make it obvious when a behavior acts autonomously in the background

---

## Ownership boundaries: what belongs where

This section defines the architectural boundary between:

- **AGENTS/OpenClaw agent policy**
- **the plugin substrate**
- **optional automation packs**

### A. AGENTS/OpenClaw agent policy

These behaviors belong to agent policy, not to the substrate:

- deciding when memory should be consulted
- deciding whether a memory hit is sufficient to trust
- deciding whether to ask follow-up questions
- deciding whether to checkpoint or store a memory as part of task strategy
- deciding how to communicate with users or other agents
- deciding whether to obey organizational communication rules
- deciding whether to prefer memory evidence before answering historical questions

In short: **reasoning and behavior policy belong to the agent**.

Examples:

- “Before answering historical questions, search memory first” is an **agent policy**.
- “When collaborating with another agent, include citations from memory” is an **agent policy**.
- “Do not send unanswered questions unless memory has been checked” is an **agent policy**.

The plugin may support these policies, but it should not silently define them in its mandatory base layer.

### B. Plugin substrate

These behaviors belong to the substrate:

- exposing memory search/read/write primitives
- resolving the local vault and session identity
- formatting returned memory context safely
- providing local-first access to stored markdown memories
- enforcing technical safety/integrity checks for plugin execution
- exposing optional hooks or APIs that higher layers can build on

In short: **capabilities and safe infrastructure belong to the substrate**.

Examples:

- `memory_search` returns ranked vault matches.
- `memory_get` retrieves a specific note.
- `memory_categories` and `memory_classify` preserve a stable category surface for retrieval and organization.
- `memory_write_vault`, `memory_write_boot`, and `memory_capture_source` map writes to the correct memory layer.
- explicit `checkpoint` writes session state when requested.
- vault path detection finds the correct local vault for an agent.

### C. Optional automation packs

These behaviors belong to automation packs:

- injecting session recap into prompts automatically
- injecting relevant vault context before prompt build
- creating startup recovery notices automatically
- auto-checkpointing on lifecycle events
- observing active sessions without explicit requests
- running fact extraction opportunistically on hooks
- running weekly reflection jobs
- appending communication protocol instructions
- rewriting outbound messages
- canceling or filtering messages based on memory/policy checks

In short: **automation, orchestration, and legacy convenience behavior belong to packs**.

---

## Behavior classification table

| Behavior | AGENTS / OpenClaw policy | Plugin substrate | Optional automation packs |
| --- | --- | --- | --- |
| Decide whether memory should be consulted | Yes | No | No |
| Search local vault on explicit request | No | Yes | Can call into substrate |
| Retrieve a specific memory document | No | Yes | Can call into substrate |
| Resolve active vault path | No | Yes | Can depend on it |
| Validate executable path / integrity | No | Yes | Can depend on it |
| Inject session recap automatically | No | No | Yes |
| Inject memory context automatically before prompt build | No | No | Yes |
| Add recall mandate text to prompts | Usually yes as policy, if automated then via pack | No | Yes when plugin performs it automatically |
| Auto-checkpoint on reset/new session events | No | No | Yes |
| Observe heartbeat / compaction / reset events | No | No | Yes |
| Run fact extraction during lifecycle hooks | No | No | Yes |
| Run weekly reflection jobs | No | No | Yes |
| Enforce communication protocol appendix | Yes in principle | No | Yes if plugin injects it |
| Rewrite outbound messages | Yes in principle | No | Yes if plugin performs rewriting |
| Cancel outbound messages that violate policy | Yes in principle | No | Yes if plugin enforces it |

---

## Mapping of current plugin behaviors into the new architecture

The existing codebase already contains the raw pieces needed for this split.

### Substrate-aligned pieces

These components fit naturally in the core layer:

- config parsing and vault-path resolution
- session key and agent ID sanitization
- executable integrity verification
- vault search and recap retrieval helpers
- explicit CLI or library-backed memory access

### Automation-pack-aligned pieces

These components should be documented and surfaced as optional packs:

- `before_prompt_build` context injection behavior
- startup recovery notice handling
- session recap preloading
- `before_reset` auto-checkpointing
- observer cron triggers on lifecycle hooks
- fact extraction on lifecycle hooks
- weekly reflection scheduling
- communication protocol appendix injection
- message sending rewrite/filter behavior

### Onboarding/config-aligned pieces

These are the controls that should evolve into preset-driven UX:

- booleans that enable or disable automated hook behavior
- context profile selection
- preset expansion into per-feature flags
- migration path for older configs

---

## Default policy recommendation

The recommended default for a new installation is:

- install and enable the **core memory substrate**
- default to the **Thin / Agent-driven** preset
- offer **Hybrid** and **Legacy automation** during onboarding
- preserve backward compatibility for explicit legacy configs

This default keeps ClawVault aligned with a minimal local-first memory philosophy while still supporting users who want more automation.

---

## Non-goals

This architecture intentionally does **not** make the plugin responsible for:

- defining the full reasoning policy of AGENTS/OpenClaw agents
- forcing a single collaboration style
- requiring prompt injection as the primary integration mechanism
- making autonomous memory operations unavoidable

---

## Summary

The plugin should be understood as a layered system:

- **Core memory substrate**: always available, local-first, explicit, non-autonomous
- **Optional automation packs**: legacy-compatible, opt-in orchestration and policy-like behaviors
- **Onboarding/config UX**: first-run selection and presets that clearly expose the tradeoff between minimalism and automation

This split keeps the base plugin small and principled while preserving the richer automation workflows that some users still want.
