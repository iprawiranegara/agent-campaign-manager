---
name: campaign-orchestrator
description: Coordinate substantial research, engineering, and other substantial agent campaigns through durable work packages, receipts, and parent reconciliation.
---

# Campaign orchestrator

Use the campaign MCP tools as the live control record. The chat transcript and a handoff note are not the campaign record.

## Start of a session

1. Read the applicable repository `AGENTS.md` and README cascade.
2. Call `campaign_list` or `campaign_search` when the owner has not supplied a campaign ID.
3. Call `campaign_detail` for the candidate record while the session is unbound.
4. Confirm the owner-selected campaign identity, scope, lifecycle, and phase. For a new owner-approved objective, call `campaign_create`; it does not bind the session.
5. Call `campaign_bind` with the exact identity digest and current version. A fresh process is always unbound.
6. Call `campaign_status` and then `campaign_preflight`. Report the identity, version, lifecycle, phase, authorities, protected state, and one next permitted action.

`campaign_open`, `campaign_resume`, and `campaign_close` are retired. If one is called, return the structured `DEPRECATED_TOOL` error and follow its replacement. Never treat a phase label as a campaign ID. Never make an existing ID fit a changed objective. If binding returns `CAMPAIGN_IDENTITY_MISMATCH`, report the differing fields and stop. Do not retry the same payload.

## Work dispatch

The parent owns the campaign. Register one `campaign_work_package` per bounded child task. Include allowed paths, forbidden actions, required governance, required verification, and stop conditions. The child must return evidence through `campaign_receipt`; the parent reviews and calls `campaign_reconcile`.

## Campaign continuity and user steering

Use this workflow for long-running research, engineering, or other substantial campaigns. Do not start or bind a campaign for every ordinary task. During an active campaign, treat a new user message as steering its existing objective by default. Identify whether it adds a requirement, corrects a decision, changes priority, asks for status, or explicitly replaces, pauses, or stops the campaign. Apply it to the relevant workstream, tell affected agents what changed, preserve other workstreams and accepted decisions, then review status and resume outstanding work. A completed steered item does not complete the whole campaign. Report campaign completion only after authorized deliverables and gates are verified. Follow an explicit user pause, cancellation, or replacement. If a material conflict cannot be resolved, clarify it while continuing independent work where possible.

The campaign record preserves identity, work packages, receipts, and status across sessions. It does not observe every user prompt, direct subagents, or guarantee the parent's behavior. The parent remains responsible for the whole campaign. Research and engineering governance stay profile-specific; do not apply Co-Researcher requirements to every campaign.

The campaign layer records model and provider metadata. Those fields do not grant permission and cannot change the charter.

## Mutation discipline

Every mutation includes the current `expected_version` and `actor`. Do not spawn acknowledgement-only children. Do not close a campaign from a child thread.

## Recovering from errors

- For an ordinary input error, correct it and retry once only when the correction is unambiguous and authorized.
- For a version conflict, refresh `campaign_status` once when bound, or `campaign_detail` once when unbound. Retry at most once only if the same action remains intended and authorized.
- On `CAMPAIGN_IDENTITY_MISMATCH`, stop the operation and verify the intended campaign; do not guess or retry the same payload. Never widen the scope automatically.
- If a write outcome is unknown, inspect campaign state first; do not repeat the write while its outcome is unknown.
- If recovery fails, report the exact error and continue independent authorized work where possible. Do not keep debugging the manager at the expense of the user's task.

`campaign_unbind` clears only the current session binding. It does not reload hooks or change the plugin manifest. Call it before switching campaigns in the same session. A fresh session must repeat discovery and binding.
