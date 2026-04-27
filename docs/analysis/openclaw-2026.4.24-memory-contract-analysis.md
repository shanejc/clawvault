# OpenClaw 2026.4.24 Memory Plugin Contract Analysis (Phases 1–4)

Date: 2026-04-27 (UTC)
Scope: OpenClaw memory plugin contract/interface **v2026.4.24** vs current ClawVault plugin implementation.
Method: Evidence-first; no inferred behavior without a cited source.

---

## 1) Canonical contract dossier (OpenClaw 2026.4.24)

### 1.1 Authoritative source set captured

- OpenClaw release tag: `v2026.4.24` (published 2026-04-25, includes signed tag and commit pointer `cbcfdf6`).
  - Source: https://github.com/openclaw/openclaw/releases/tag/v2026.4.24
- Memory plugin manifest at tag:
  - `extensions/memory-core/openclaw.plugin.json`
  - Source: https://raw.githubusercontent.com/openclaw/openclaw/v2026.4.24/extensions/memory-core/openclaw.plugin.json
- Plugin manifest contract doc at tag:
  - `docs/plugins/manifest.md`
  - Source: https://raw.githubusercontent.com/openclaw/openclaw/v2026.4.24/docs/plugins/manifest.md
- Plugin SDK overview (registration surface) at tag:
  - `docs/plugins/sdk-overview.md`
  - Source: https://raw.githubusercontent.com/openclaw/openclaw/v2026.4.24/docs/plugins/sdk-overview.md
- Plugin hooks/lifecycle contract at tag:
  - `docs/plugins/hooks.md`
  - Source: https://raw.githubusercontent.com/openclaw/openclaw/v2026.4.24/docs/plugins/hooks.md
- OpenClaw memory concept contract at tag:
  - `docs/concepts/memory.md`
  - Source: https://raw.githubusercontent.com/openclaw/openclaw/v2026.4.24/docs/concepts/memory.md
- Plugin operations semantics at tag:
  - `docs/tools/plugin.md`
  - Source: https://raw.githubusercontent.com/openclaw/openclaw/v2026.4.24/docs/tools/plugin.md

### 1.2 Contract matrix (memory-plugin relevant clauses)

| ID | Area | OpenClaw 2026.4.24 contract clause | Normative strength | Evidence |
|---|---|---|---|---|
| OC-MAN-001 | Manifest | Native plugin must ship `openclaw.plugin.json` in plugin root. | MUST | `docs/plugins/manifest.md` |
| OC-MAN-002 | Manifest | `id` is required. | MUST | `docs/plugins/manifest.md` |
| OC-MAN-003 | Manifest | `configSchema` is required, inline JSON Schema object. | MUST | `docs/plugins/manifest.md` |
| OC-MAN-004 | Manifest | `kind` is optional and when present must be `"memory"` or `"context-engine"` for exclusive slots. | MUST (if field present) | `docs/plugins/manifest.md` |
| OC-MAN-005 | Manifest | Manifest metadata is validated without executing plugin runtime. | MUST (host behavior) | `docs/plugins/manifest.md` |
| OC-SDK-001 | SDK | Memory plugin preferred exclusive API is `registerMemoryCapability(...)`. | SHOULD/PREFERRED | `docs/plugins/sdk-overview.md` |
| OC-SDK-002 | SDK | Legacy-compatible memory registration seams still exist (`registerMemoryRuntime`, `registerMemoryPromptSection`, `registerMemoryFlushPlan`/resolver, etc.). | MAY/COMPAT | `docs/plugins/sdk-overview.md` |
| OC-SDK-003 | SDK | Memory embedding adapters register via `registerMemoryEmbeddingProvider(...)` and user config resolves against registered ids. | SHOULD | `docs/plugins/sdk-overview.md` |
| OC-HOOK-001 | Hooks | Plugin runtime lifecycle/hooks register via `api.on(...)`. | MUST (for hook behavior) | `docs/plugins/hooks.md`, `docs/plugins/sdk-overview.md` |
| OC-HOOK-002 | Hooks | `before_prompt_build` is a typed hook for prompt context/system mutation. | MAY | `docs/plugins/hooks.md` |
| OC-HOOK-003 | Hooks | `message_sending` supports rewrite/cancel with terminal cancel semantics. | MAY | `docs/plugins/hooks.md` |
| OC-HOOK-004 | Hooks | `session_start`, `session_end`, `gateway_start`, `before_reset`, `before_compaction`, `agent_end` are supported lifecycle surfaces. | MAY | `docs/plugins/hooks.md` |
| OC-HOOK-005 | Hooks | Hook ordering/terminal decision semantics are defined (e.g., cancel/block true terminal). | MUST (if returning decisions) | `docs/plugins/hooks.md` |
| OC-MEM-001 | Memory concept | Active memory tools come from active memory plugin (default `memory-core`). | HOST EXPECTATION | `docs/concepts/memory.md` |
| OC-MEM-002 | Memory concept | `memory_search` and `memory_get` are explicit memory tools owned by active memory plugin. | EXPECTED CAPABILITY | `docs/concepts/memory.md` |
| OC-OPS-001 | Operations | Config changes require gateway restart; plugin runtime has no supported hot reload. | MUST (operational) | `docs/tools/plugin.md` |

---

## 2) ClawVault implementation inventory (current repository)

### 2.1 Interface/contract declaration points

- Native manifest:
  - `openclaw.plugin.json`
- Runtime plugin entry and registration:
  - `src/openclaw-plugin.ts`
- Local type contract surface (OpenClaw plugin API subset + hook/event types):
  - `src/plugin/openclaw-types.ts`
- Pack-mode precedence and behavior gating:
  - `src/plugin/config.ts`
  - `src/plugin/packs.ts`
- Legacy slot compatibility path:
  - `src/plugin/slot.ts`
- Architecture constraints (local policy boundary):
  - `src/plugin/ARCHITECTURE.md`

### 2.2 Inventory map

#### Manifest layer
- Declares `id`, `name`, `version`, `kind: "memory"`, `description`, and rich `configSchema` with `additionalProperties: false`.
- Declares UI hints for config keys.

#### Registration layer
- Registers memory contract surfaces via:
  - `registerMemoryCapability`
  - `registerMemoryRuntime`
  - `registerMemoryPromptSection`
  - `registerMemoryFlushPlanResolver` (or legacy alias fallback)
  - `registerMemoryEmbeddingProvider`
  - legacy aliases `registerMemoryPrompt`, `registerMemoryFlush`, `registerMemoryEmbedding`
- Registers core memory tools:
  - `memory_search`, `memory_get`, `memory_categories`, `memory_classify`
  - plus explicit write/capture tools (`memory_write_vault`, `memory_write_boot`, `memory_capture_source`, `memory_update`, `memory_patch`)

#### Hook/lifecycle layer
- Conditionally registers automation hooks when pack behavior is enabled.
- Uses explicit lifecycle hooks:
  - `before_prompt_build`, `message_sending`, `gateway_start`, `session_start`, `session_end`, `before_reset`, `before_compaction`, `agent_end`

#### Compatibility layer
- If memory capability API absent, returns legacy `plugins.slots.memory` object.
- Also exports deprecated helper `registerMemorySlot(...)`.

---

## 3) Clause-by-clause conformance (OpenClaw contract vs ClawVault)

Legend: `PASS` / `PARTIAL` / `FAIL` / `UNVERIFIED`

| Contract ID | Status | ClawVault evidence | Notes |
|---|---|---|---|
| OC-MAN-001 | PASS | `openclaw.plugin.json` exists at repo root. | Native manifest present. |
| OC-MAN-002 | PASS | `openclaw.plugin.json` declares `id: "clawvault"`. | Required field present. |
| OC-MAN-003 | PASS | `openclaw.plugin.json` declares `configSchema` object. | Required field present. |
| OC-MAN-004 | PASS | `openclaw.plugin.json` declares `kind: "memory"`. | Valid enum member. |
| OC-MAN-005 | UNVERIFIED | No host-runtime execution in this analysis turn. | Needs OpenClaw host validation run against this manifest. |
| OC-SDK-001 | PASS | `registerMemoryContractSurface(...)` calls `api.registerMemoryCapability(...)` when available. | Uses preferred API when provided. |
| OC-SDK-002 | PASS | Same function registers modern + legacy-compatible memory seams conditionally. | Compatibility coverage appears intentional and explicit. |
| OC-SDK-003 | PASS | Calls `registerMemoryEmbeddingProvider(embedding, { ownerPluginId: api.id })`. | Embedding adapter registration implemented. |
| OC-HOOK-001 | PASS | Uses `api.on(...)` for all hook subscriptions in `registerAutomationHooks`. | Hook registration pattern matches SDK/hook docs. |
| OC-HOOK-002 | PASS | Registers `before_prompt_build` hook with typed handler pipeline. | Supported and implemented. |
| OC-HOOK-003 | PASS | Registers `message_sending` hook and processes callback decisions with cancel/rewrite path. | Supported and implemented. |
| OC-HOOK-004 | PASS | Registers lifecycle hooks listed by OpenClaw docs. | Coverage is broad and aligned. |
| OC-HOOK-005 | PARTIAL | Local callback-decision policy layer applies custom `handled/skip/fallback_auto/error` semantics before returning hook outputs. | Host terminal semantics are respected at final hook return, but intermediary callback policy abstraction adds behavior not directly defined by OpenClaw docs; needs host-level behavioral verification. |
| OC-MEM-001 | PASS | Plugin kind is memory and registers memory capability/tool surface. | Fits active-memory plugin role. |
| OC-MEM-002 | PASS | Registers `memory_search` and `memory_get`. | Required user-facing capability present. |
| OC-OPS-001 | UNVERIFIED | No gateway restart/load test executed in this analysis turn. | Needs live OpenClaw runtime check. |

---

## 4) High-risk deep dives (current findings)

## 4.1 Manifest/schema fidelity

**Observed alignment:**
- Required native manifest keys and memory kind are present.
- `configSchema.additionalProperties=false` is strict and aligns with OpenClaw manifest validation expectations.

**Potential risk:**
- ClawVault manifest includes many plugin-specific config keys not represented in OpenClaw docs examples; this is expected, but only host-schema validation can prove end-to-end acceptance (`UNVERIFIED` until runtime validation).

## 4.2 Lifecycle/hook wiring

**Observed alignment:**
- Hook names in code align with documented OpenClaw hook catalog for memory/lifecycle automation surfaces.
- Hook registration is conditional via automation packs, reducing always-on policy behavior.

**Potential risk:**
- ClawVault introduces an internal callback decision protocol (`handled`, `skip`, `fallback_auto`, `error`) layered on top of OpenClaw hook semantics. This is valid as internal logic, but requires host-behavior tests to ensure terminal decisions (`cancel`, `block`) are always emitted in contract-compliant shape.

## 4.3 Config precedence model

**Observed alignment:**
- Explicit precedence is codified in `getPackBehaviorMode(...)`:
  1) `memoryBehaviorDomains`
  2) `packToggles`
  3) `automationMode=true`
  4) preset defaults
  5) off
- This is deterministic and testable.

**Potential risk:**
- Two naming eras coexist (`packPreset` and deprecated `automationPreset`; modern and legacy booleans). This is a compatibility advantage, but regression risk remains high without exhaustive precedence tests across mixed configs.

## 4.4 Memory-policy boundary (architecture rule)

**Observed alignment:**
- `src/plugin/ARCHITECTURE.md` hard rule explicitly states plugin must not own memory policy.
- Code gates most autonomous behaviors behind packs; substrate tools remain available regardless.

**Potential risk:**
- `agent_end` writeback remains active even when `capture-observation` automation pack is off (explicit in `src/openclaw-plugin.ts`). This may still be architecturally acceptable (conservative memory writeback), but should be explicitly classified as substrate vs automation policy and validated against intended architecture baseline.

## 4.5 Failure/compatibility semantics

**Observed alignment:**
- Memory capability registration gracefully degrades to legacy slot registration when capability API is absent.
- Multiple legacy registration aliases are supported.

**Potential risk:**
- Runtime compatibility with exact OpenClaw 2026.4.24 host remains `UNVERIFIED` in this phase because no host-executed integration run was performed.

---

## Immediate next artifacts required to close remaining `UNVERIFIED` rows

1. Run OpenClaw 2026.4.24 host validation against this plugin manifest and registration path.
2. Execute contract-focused integration tests covering:
   - hook terminal semantics (`message_sending.cancel`, lifecycle no-op cases)
   - capability API present/absent paths
   - mixed modern+legacy config precedence matrix
3. Produce a final PASS/PARTIAL/FAIL conformance report with runtime evidence links.
