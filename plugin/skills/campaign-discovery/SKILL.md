---
name: campaign-discovery
description: Discover, inspect, create, and explicitly bind the owner-selected campaign for the current agent session.
---

# Campaign discovery and binding

Campaign mode begins unbound. Use the durable SQLite record to select a campaign; do not infer one from the repository name, prompt text, phase, or a stale handoff.

1. Call `campaign_list` or `campaign_search`.
2. Call `campaign_detail` for each candidate that needs review.
3. Ask the owner to select one record when more than one candidate remains.
4. For a genuinely new objective, call `campaign_create` with the owner-approved identity. It creates a record but leaves the session unbound.
5. Call `campaign_bind` with the exact `identity_digest`, current `expected_version`, actor, run ID, thread ID, and client metadata.
6. Call `campaign_status` and `campaign_preflight` after binding.

Binding changes only the current session state. It does not change campaign version, install hooks, reload a plugin, or alter client configuration. `campaign_unbind` clears that session state. A new process starts unbound and must repeat this sequence.

On `CAMPAIGN_IDENTITY_MISMATCH`, stop the operation, report the mismatch, and verify the intended campaign; do not guess or retry the same payload. Do not change scope or lifecycle to make a record fit. Never call retired `campaign_open` or `campaign_resume` to guess which record the owner meant.

## Recovering from errors

- For an ordinary input error, correct it and retry once only when the correction is unambiguous and authorized.
- For an unbound version conflict, refresh `campaign_detail` once. Retry binding at most once only if the campaign identity and intended action still match and remain authorized.
- If a write outcome is unknown, inspect campaign state first; do not repeat the write while its outcome is unknown.
- If recovery fails, report the exact error and continue independent authorized work where possible. Do not keep debugging the manager at the expense of the user's task.
