# ClawVault Project

## Purpose

ClawVault is the long-term memory system for Lucy/OpenClaw.

This project exists to replace the old "files are the whole memory system" model with a tiered memory model:

- `MEMORY.md` = boot-critical cache
- `clawvault/` = durable system of record
- daily/chat/source files = raw chronology and evidence

The goal is not just to store memory better. The goal is to create prompt-enforced behavior so Lucy reliably:

1. recalls from the right layer before answering when continuity matters
2. writes durable information to the right layer after responding
3. keeps boot memory lean instead of turning it into an archive

---

## Design Principles

- Prompt behavior comes first.
- `AGENTS.md` should be concise, direct, and imperative.
- The memory model must be explicit.
- "Write it down" becomes "write to the right layer."
- Hooks are not enough; behavior must be enforced by prompt rules.
- ClawVault is not a transcript dump.
- `MEMORY.md` stays small and curated.
- Raw logs remain available as source material.
- Retrieval quality matters; search/configuration must be installed early enough to test.
- Avoid large-context prompt bloat.

---

## Memory Model

### 1. Boot / Reflex Memory
**File:** `MEMORY.md`

Use for:
- identity
- core personal context
- stable preferences
- critical operating assumptions
- active frontier context that must be known on boot

Constraints:
- lean
- curated
- high-frequency only
- not a history dump

### 2. Long-Term Memory
**Location:** `clawvault/`

Use for:
- people
- projects
- systems
- decisions
- meetings
- lessons
- historical context
- durable facts and handoffs

Constraints:
- structured
- reviewable
- source-aware
- durable, not ephemeral

### 3. Source / Chronology Layer
**Examples:** `memory/YYYY-MM-DD.md`, `memory/chat-*.md`, imported notes, transcripts

Use for:
- raw capture
- chronology
- evidence
- context for later distillation

Constraints:
- not the primary recall layer
- not the durable memory layer by default

---

## Core Behavioral Rules

These will eventually be reflected in `AGENTS.md`.

### Recall Rule
Before answering questions involving continuity, Lucy must consult the appropriate memory layer instead of relying on session memory or guesswork.

Typical triggers:
- prior work
- people
- preferences
- decisions
- ongoing projects
- commitments
- history

### Writeback Rule
After meaningful interactions, Lucy must classify what was learned and write it to the correct layer.

### Classification Rule
New information must be classified as one of:
- boot memory
- long-term memory
- source-only chronology
- discard

### Distillation Rule
Do not blindly copy raw conversation into long-term memory. Distill, structure, and preserve provenance.

---

## AGENTS.md Strategy

`AGENTS.md` should not become a giant memory manual.

It should contain a small runtime kernel with this order:

1. **Memory Model**
   - `MEMORY.md` = boot-critical cache
   - `clawvault/` = durable system of record
   - raw files = source material
   - vault wins on conflict unless explicitly curated otherwise

2. **Write It Down**
   - do not trust session memory
   - write durable things to the vault
   - write boot-critical summaries to `MEMORY.md`
   - write raw chronology to source/daily files
   - write to the right layer, not just somewhere

3. **Optional tiny recall/writeback rule**
   - recall before answering when continuity matters
   - classify after responding when durable information was learned

The point is a compact "thou shalt" kernel, not a long essay.

---

## Planned Repository Structure

The project should distinguish between:

1. **ClawVault-native structure** — folders ClawVault clearly treats as first-class
2. **Project overlay structure** — additional docs/folders we add without fighting the tool

### ClawVault-native structure

These should be preserved where practical because ClawVault has first-class commands or indexing assumptions around them:

```text
<vault>/
  people/
  projects/
  decisions/
  lessons/
  tasks/
  backlog/
  handoffs/
  inbox/
  templates/
  .clawvault/
```

Other native/default categories may also exist depending on init/config, but the list above is the minimum set we should treat as semantically important.

### Project overlay structure

These are safe additions for our workflow and documentation:

```text
<vault>/
  PROJECT.md
  DECISIONS.md
  VAULT.md
  MEMORY-SYSTEM.md
  meetings/
  systems/
  sources/
  imports/
  reports/
```

### Notes
- `PROJECT.md` = master implementation plan
- `DECISIONS.md` = architecture decisions log
- `VAULT.md` = rules for using the vault
- `.md` remains the default runtime-friendly note format
- `qmd` in this project refers to **`tobi/qmd`**, the ClawVault-relevant retrieval dependency/fallback tool, **not** Quarto Markdown
- custom folders are acceptable, but native operational folders should not be casually renamed or replaced

---

## QMD Position

In this project, **QMD means `tobi/qmd`**, not Quarto Markdown.

QMD is an installation/configuration concern, not a philosophical pillar of the memory model.

What matters conceptually:
- `MEMORY.md` = boot context
- ClawVault = durable/searchable knowledge store
- prompt behavior = recall/writeback discipline

What matters operationally:
- install/configure ClawVault correctly
- install/configure QMD at the right point
- verify search/retrieval works before depending on it heavily

Current working state:
- ClawVault has built-in search/hybrid retrieval capability
- QMD install via npm is currently failing in this environment
- therefore the project should proceed without depending on QMD initially
- extra markdown folders can still participate in indexing/graph/search, but command semantics are only partially schema-agnostic
- if/when qmd is revisited, it should be for local retrieval performance/compatibility, not as a reason to reintroduce unwanted cloud behavior

---

## Implementation Order

This is the current project sequence, updated to reflect what has actually been done.

### Phase 1 — Side Work First ✅ complete
Completed:
- created `clawvault/PROJECT.md`
- created `clawvault/DECISIONS.md`
- created `clawvault/VAULT.md`
- created `MEMORY-SYSTEM.md`
- established the memory model and decision log before changing `AGENTS.md`

Why this mattered:
The project needed a clear constitution before introducing runtime behavior changes.

### Phase 2 — Install and Verify What Actually Works ✅ complete
Completed:
- installed ClawVault CLI
- initialized the vault
- verified manual indexing/search/retrieval works
- confirmed qmd is blocked in this environment for now
- confirmed the upstream OpenClaw integration docs/package shape are misaligned
- intentionally chose **manual ClawVault mode** instead of the upstream plugin/hook path

Why this mattered:
We now know the working subset and are building on that instead of on broken or misaligned packaging paths.

### Phase 3 — Initialize Native Structure, Then Add Overlay ✅ complete
Completed:
- kept ClawVault native structure intact
- added project overlay docs/folders:
  - `PROJECT.md`
  - `DECISIONS.md`
  - `VAULT.md`
  - `MEMORY-SYSTEM.md`
  - `meetings/`
  - `systems/`
  - `sources/`
  - `imports/`
  - `reports/`

Guiding rule:
**overlay, don’t overthrow**.

### Phase 4 — Seed Minimum Viable Vault ✅ complete
Completed:
- `projects/clawvault.md`
- `decisions/memory-model-write-to-the-right-layer.md`
- `people/shane-clifford.md`
- `systems/openclaw-memory-system.md`
- `systems/lucy-operating-model.md`
- reindexed successfully and verified manual retrieval path

Why this mattered:
The vault now has a semantic spine, not just governance docs.

### Phase 5 — Minimal AGENTS.md Update
Next step.

Goal:
Make the smallest non-destructive AGENTS update first.

Install:
- memory model in compact form
- brief distinction between boot memory and long-term memory

Do **not** aggressively rewrite everything else yet.

### Phase 6 — Rewrite "Write It Down"
After the minimal memory-model update lands, rewrite the existing section so it reflects the new system.

Old model:
- files are the whole strategy

New model:
- write to the correct layer

### Phase 7 — Transition Period
For a short period after AGENTS changes:
- keep `MEMORY.md` intact
- keep raw daily/chat notes intact
- start using ClawVault for durable new memory
- avoid aggressive pruning
- validate that AGENTS behavior and manual vault usage stay aligned

### Phase 8 — Bootstrap Existing Memory
Run the migration/classification effort:
1. review `MEMORY.md`
2. classify what stays in `MEMORY.md`
3. promote durable context into ClawVault
4. process meeting notes
5. distill daily/chat logs selectively

### Phase 9 — Trim Boot Memory Last
Only after behavior feels stable:
- shrink `MEMORY.md`
- keep only truly boot-critical material
- move detailed history out to ClawVault

### Phase 10 — Build Our Own Thin OpenClaw Plugin
Only after the memory model, vault usage, and AGENTS behavior are working well in manual mode:
- design a minimal plugin that supports our model instead of overriding it
- keep the plugin narrow, explicit, and auditable
- avoid automatic behavior that acts like a second constitution
- prefer simple adapter behavior over embedded reflection/maintenance policy
- make local-first behavior the default

Goal:
A plugin that serves **our** memory architecture rather than importing a broader one from upstream.

---

## Bootstrap Strategy

The bootstrap process is not "move everything into the vault."

It is:
1. classify
2. promote
3. link
4. preserve provenance
5. leave raw evidence where appropriate

### Bootstrap Sources
- `MEMORY.md`
- `memory/YYYY-MM-DD.md`
- `memory/chat-*.md`
- meeting notes
- existing system docs as needed

### Import Priority
1. people
2. systems
3. projects
4. decisions
5. meetings
6. selected lessons and historical context
7. task extraction if needed

### Review Rule
Imported notes should begin as draft/reviewable where practical.

---

## Customization Guidance

### Safe to customize / add
These are good candidates for project-specific additions:
- top-level planning docs like `PROJECT.md`, `DECISIONS.md`, `VAULT.md`
- supporting folders like `meetings/`, `systems/`, `sources/`, `imports/`, `reports/`
- search/qmd configuration
- categories, cautiously, when they are additive rather than destructive

### Custom templates/schemas
Not required for the initial implementation.

Reason:
ClawVault already provides native structure and template support for its own operational model, and our current overlay docs do not yet justify extra template/schema machinery.

Revisit only if high-volume overlay note types emerge later (for example `meetings/` or `systems/`).

### Do not casually rename or replace
These appear to be semantically important to ClawVault commands or indexing:
- `projects/`
- `tasks/`
- `backlog/`
- `handoffs/`
- `people/`
- `decisions/`
- `lessons/`
- likely `agents/` and `commitments/`

### Working rule
Overlay, don’t overthrow.

Use ClawVault’s native folders for the things ClawVault manages directly. Add our own structure around that rather than trying to replace its operational model.

---

## What Belongs Where

### Put in `MEMORY.md`
Only if it is:
- frequently needed
- stable
- boot-critical
- identity-defining
- operationally central

### Put in `clawvault/`
If it is:
- durable
- structured
- likely useful later
- linked to people/projects/systems/decisions
- too detailed for boot memory

### Leave in raw/source files
If it is:
- chronology
- evidence
- useful but not yet distilled
- noisy or low-value in raw form

### Discard
If it is:
- transient noise
- spam
- not useful later
- not worth source retention

---

## Current Open Questions

- Exact final wording for the `AGENTS.md` memory kernel
- Exact structure and scope of `VAULT.md`
- Whether to maintain a separate `MEMORY-SYSTEM.md` or fold some of it into `VAULT.md`
- Exact note schemas and frontmatter rules
- How much automation to use for bootstrap vs manual curation
- Whether to create generated indexes immediately or after initial migration

---

## Immediate Next Deliverables

1. `clawvault/PROJECT.md` ✅
2. `clawvault/DECISIONS.md` ✅
3. `clawvault/VAULT.md`
4. `MEMORY-SYSTEM.md`
5. initial folder structure
6. install/verify ClawVault + `tobi/qmd`
7. seed notes
8. draft `AGENTS.md` replacement sections

---

## Security / Local-First Posture

The project should prefer **as local as possible** operation.

### Desired posture
- local vault storage
- local/in-process retrieval where possible
- no hosted embeddings by default
- no hosted rerank by default
- no cloud LLM use by default
- OpenClaw remains the preferred place for higher-level reflection/maintenance/orchestration work

### Upstream plugin posture
We are **not** adopting the upstream ClawVault plugin as part of this project.

Reason:
- its current packaging/docs are misaligned
- its automation layer is broad enough to act like a second behavior engine
- that conflicts with the AGENTS-first design we want

### Local-only direction
If/when ClawVault model features are used manually, prefer:
- `openclaw` provider when OpenClaw itself is pointed at local models
- `ollama` for compression/embeddings where supported
- `search.rerank.provider none`
- `observer.factExtractionMode off` unless explicitly revisited
- `inject.useLlm false` unless explicitly revisited

This keeps ClawVault closer to a storage/retrieval substrate and pushes reasoning-heavy behavior back toward OpenClaw agents.

---

## Current Toolchain Status

### Working now
- ClawVault CLI installation
- local vault initialization
- manual vault usage
- project/docs work around the vault

### Blocked right now
- qmd installation via npm in this environment
- OpenClaw hook-pack installation from the published ClawVault package (`package.json` missing `openclaw.hooks`)

### Operating mode for now
Proceed in **manual ClawVault mode**.

That means:
- use ClawVault directly
- do not depend on qmd for initial progress
- do not depend on the upstream ClawVault plugin/hook automation
- let `AGENTS.md` and explicit OpenClaw orchestration own behavior policy

---

## Future Automation Direction

If automation is added later, it should come from a **thin custom OpenClaw plugin** aligned to our design rather than the current upstream plugin package.

That plugin should:
- respect the AGENTS-first memory model
- remain local-first by default
- keep behavior narrow and auditable
- avoid becoming a second implicit policy engine
- use ClawVault as substrate, not as the owner of reasoning policy

---

## Success Criteria

The project is succeeding if:
- Lucy can stay functional while the migration happens
- `MEMORY.md` gets smaller and sharper, not bigger
- durable context accumulates in ClawVault instead of in random files
- the prompt rules are short but reliable
- recall happens before continuity-dependent answers
- durable information gets classified after meaningful interactions
- the system becomes more coherent, not more magical
