# ClawVault Decisions

This file records decisions already made or strongly directionally agreed, so the project does not drift every time it is discussed.

---

## D-001 — Memory model comes before Write It Down
**Status:** decided

The architecture must be defined before the behavioral write rules.

Reason:
The old "Write it down" section belonged to a pre-vault world where files were the whole memory system. In the ClawVault model, write behavior must be derived from an explicit memory model.

Implication:
`AGENTS.md` should first define the memory layers, then define how to write to them.

---

## D-002 — `MEMORY.md` remains the boot-critical cache
**Status:** decided

`MEMORY.md` is not being eliminated.

Role:
- reflex memory
- active/high-frequency context
- must-know-on-boot context

Constraint:
It must stay lean and curated.

---

## D-003 — ClawVault is the durable system of record
**Status:** decided

ClawVault is the long-term memory layer.

Use it for:
- durable facts
- projects
- people
- systems
- decisions
- meetings
- lessons
- handoffs
- historical context

Constraint:
ClawVault is not a raw transcript dump.

---

## D-004 — Raw daily/chat files remain source material
**Status:** decided

Daily notes, chat exports, and similar files remain useful, but they are not the primary durable memory strategy.

Role:
- chronology
- evidence
- source material for later distillation

---

## D-005 — The rule is not “write somewhere”; it is “write to the right layer”
**Status:** decided

The old memory discipline was: write things to files.

The new discipline is:
- boot-critical summaries → `MEMORY.md`
- durable memory → ClawVault
- raw chronology/evidence → source files

This is the core operational reframing of the project.

---

## D-006 — Prompt enforcement is central
**Status:** decided

The project depends on prompt rules, not just tools or hooks.

Reason:
Hooks do not enforce behavior. The agent must be explicitly instructed how to recall and how to write back.

Implication:
The `AGENTS.md` update is a first-class deliverable, not an afterthought.

---

## D-007 — The runtime prompt must stay concise
**Status:** decided

The memory behavior rules in `AGENTS.md` should be as concise and direct as possible while still producing correct behavior.

Reason:
The goal is a compact "thou shalt" kernel, not a long explanatory manual.

Implication:
Longer explanations belong in support docs, not in the runtime prompt.

---

## D-008 — `AGENTS.md` is the runtime kernel, not the whole design doc
**Status:** decided

`AGENTS.md` should contain only the essential behavioral rules.

Recommended order:
1. Memory Model
2. Write It Down
3. optional tiny recall/writeback rule

Support docs can be fuller.

---

## D-009 — Side work comes before prompt dependence
**Status:** decided

Create ClawVault support structure before changing prompts to depend on it.

Do first:
- `clawvault/PROJECT.md`
- `clawvault/DECISIONS.md`
- `clawvault/VAULT.md`
- `MEMORY-SYSTEM.md`
- folder structure
- templates

Reason:
Do not make the runtime prompt depend on a system that does not exist yet.

---

## D-010 — Verify the working toolchain before prompt dependence
**Status:** decided

Before making runtime behavior depend on ClawVault, verify the subset of the toolchain that actually works in this environment.

Includes:
- ClawVault CLI
- vault initialization
- doctor/compat checks
- manual retrieval verification

Current reality:
- qmd install via npm is failing in this environment
- published hook-pack installation is blocked by missing `openclaw.hooks` metadata

Reason:
We should not build behavior around packaging paths that are currently broken.

---

## D-011 — Overlay, don’t overthrow
**Status:** decided

We should preserve ClawVault’s native operational structure and add our custom docs/folders around it.

Meaning:
- keep native folders for things ClawVault manages directly
- add project-specific structure as an overlay
- do not try to replace ClawVault’s operational ontology without a strong reason

Reason:
ClawVault appears extensible at the content/index/search layer, but only partially extensible at the command-semantics layer.

---

## D-012 — Native operational folders should not be casually renamed or replaced
**Status:** decided

Treat folders like these as semantically important unless proven otherwise:
- `projects/`
- `tasks/`
- `backlog/`
- `handoffs/`
- `people/`
- `decisions/`
- `lessons/`
- likely `agents/` and `commitments/`

Reason:
Source inspection shows multiple commands and indexes are hardwired to some of these names.

---

## D-013 — Minimal AGENTS change first, destructive cleanup later
**Status:** decided

Prompt rollout should be staged.

Sequence:
1. create the new artifacts
2. install/verify retrieval tooling
3. seed the vault
4. make the minimal AGENTS memory-model update
5. rewrite "Write It Down"
6. bootstrap/migrate
7. prune `MEMORY.md` last

Reason:
This preserves continuity while the system is being introduced.

---

## D-014 — QMD means `tobi/qmd`, not Quarto Markdown
**Status:** decided

In this project, `qmd` refers to the `tobi/qmd` package used in the ClawVault retrieval/tooling world.

It does **not** refer to Quarto Markdown.

Implication:
QMD should be treated as an installation/configuration detail in the retrieval stack, not as a conceptual pillar of the memory model.

---

## D-015 — Proceed in manual ClawVault mode until packaging issues are resolved
**Status:** decided

The project should proceed without depending on qmd or OpenClaw hook-pack automation initially.

Current blockers:
- qmd installation via npm is failing in this environment
- `openclaw hooks install clawvault` fails because the published package is missing `openclaw.hooks`

Implication:
Use ClawVault directly for now. Validate the vault, workflow, and prompt model first. Revisit qmd and hook automation later.

---

## D-016 — Local-first / no-cloud-by-default posture
**Status:** decided

ClawVault should be configured as locally as practical.

Meaning:
- no hosted embeddings by default
- no hosted rerank by default
- no cloud LLM use by default
- prefer local/in-process retrieval where possible
- prefer OpenClaw agents for reflection, maintenance, and higher-level reasoning

Reason:
This better matches Shane's trust model and keeps ClawVault closer to a storage/retrieval substrate instead of an unexpectedly networked intelligence layer.

---

## D-017 — Do not use the upstream ClawVault plugin for this project
**Status:** decided

We are not adopting the upstream ClawVault OpenClaw plugin as part of this project.

Reason:
- packaging/docs are misaligned
- the plugin automation layer is broad enough to act like a second behavior engine
- that conflicts with the AGENTS-first design we want

Implication:
Proceed in manual ClawVault mode and keep behavior policy in AGENTS/OpenClaw orchestration.

---

## D-018 — If plugin automation is added later, build our own thin plugin
**Status:** decided

If we add OpenClaw plugin automation later, it should be a thin custom plugin aligned to our memory model.

Desired properties:
- narrow and auditable
- local-first by default
- does not override or compete with AGENTS.md
- treats ClawVault as substrate, not policy owner

Reason:
The project needs an adapter to our architecture, not a second constitution.

---

## D-019 — Custom templates/schemas are not required for the initial overlay
**Status:** decided

We do not need custom templates or schemas for the initial project overlay.

Reason:
ClawVault already provides native structure/template support for its own operational model, and our current overlay artifacts (`PROJECT.md`, `DECISIONS.md`, `VAULT.md`, `MEMORY-SYSTEM.md`) are low-volume design docs rather than repeated operational note types.

Implication:
Do not spend early project effort on custom templates/schemas. Revisit later only if repeated overlay note types emerge and the pattern stabilizes.

---

## D-020 — The master plan lives in `clawvault/PROJECT.md`
**Status:** decided

The project plan should not live in AGENTS.md or in chat history.

Use:
- `clawvault/PROJECT.md` as the single source of truth for implementation order and project scope
- `clawvault/DECISIONS.md` for locked decisions

Reason:
This prevents the plan from drifting or being reinvented in conversation.
