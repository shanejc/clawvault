# Plugin Architecture Compliance Checklist

Use this checklist for any pull request that changes plugin behavior in `src/openclaw-plugin.ts` or `src/plugin/hooks/**`.

## Hard rule (must pass)

From `src/plugin/ARCHITECTURE.md`:

> **Hard rule:** “The plugin may automate memory operations, but it must not own memory policy.”

Interpretation for reviews:

- New automation behavior must be **opt-in**, not always-on.
- Core substrate behavior must remain explicit and policy-neutral.
- Any new lifecycle/message hook must be gated behind one or more automation packs.

## Reviewer checklist

- [ ] I confirmed whether this PR changes plugin behavior (hooks, automatic memory operations, message rewriting, observation, reflection, checkpointing, recovery injection).
- [ ] I verified no new always-on `api.on(...)` hooks were introduced in `registerOpenClawPlugin`.
- [ ] I verified hook registration is routed through `registerAutomationHooks(...)`.
- [ ] I verified each new hook is gated by `isPackEnabled(...)` and associated with the correct automation pack(s).
- [ ] I verified the default substrate flow still works with automation packs disabled.
- [ ] I verified changes do not move memory policy into mandatory substrate behavior.
- [ ] I verified CI includes the hook-gating architecture check script.

## CI guardrail

This repository enforces a lightweight architecture check:

- Script: `scripts/check-pack-gated-hooks.mjs`
- Command: `npm run check:architecture-hooks`

The check fails when `src/openclaw-plugin.ts` adds `api.on(...)` registrations in the always-on plugin registration path instead of pack-gated registration logic.
