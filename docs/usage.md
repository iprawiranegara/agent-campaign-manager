# Use a campaign

A campaign is a durable assignment with an immutable opening identity. Its phase and work packages can change as the assignment progresses. Use one campaign for the long-running objective; do not create a new ID for every phase or compaction.

## Start with explicit selection

1. Ask the agent to call `campaign_list` or `campaign_search`.
2. Inspect a selected record with `campaign_detail`, including its objective and scope.
3. Authorize binding that exact campaign. For new work, explicitly approve `campaign_create` first; creation leaves the conversation unbound.
4. Bind with its identity digest and current version, then read `campaign_status` and `campaign_preflight`.

For example:

> Create an engineering campaign called `parser-migration` for replacing the parser in this repository. Preserve the existing public API. Acceptance requires the parser regression suite and a real CLI run. Use the repository root as scope. Inspect the new campaign and bind this conversation to it before implementation.

The adapter supplies the runtime conversation identity. A model-supplied thread ID cannot select another conversation's binding. In Hermes, each profile also has a separate private routing channel. Threads can deliberately select the same campaign; they still bind independently.

## Work packages and evidence

Register a bounded package with `campaign_work_package`: name the objective, allowed paths, forbidden actions, verification and stop conditions. Record command/test/source evidence through `campaign_receipt`. The lead checks that evidence and calls `campaign_reconcile` to accept or reject the result.

An agent cannot set a package directly to `ACCEPTED` through `campaign_update`. Acceptance needs a completed evidence receipt and parent reconciliation. Those checks enforce the record structure; the lead is still responsible for reviewing the substance.

Every durable mutation supplies `expected_version` and an actor. A stale write returns `CAMPAIGN_VERSION_CONFLICT` without applying a second event. Read current state, check that the action is still intended, then retry an authorized correction once. Never automatically replay an operation whose outcome is unknown.

## After compaction

Once the selected conversation has compacted, its adapter restores a labelled advisory from the current bound ledger. A synthetic reminder can look like this:

```text
[Campaign checkpoint: read-only advisory; current bound campaign]
Campaign: parser-migration v12
Objective: Replace the parser while preserving the public API
Lifecycle: EXECUTING; phase: compatibility checks
1 accepted; 0 cancelled; 0 superseded
Outstanding: 1: cli-smoke (IN_PROGRESS)
Open gates: 0: none
Next permitted actions: campaign_status, campaign_preflight, campaign_receipt
```

The exact layout differs between adapters. Each reminder is capped at 2,000 characters; long fields/lists are shortened, and an unsafe projection is omitted. The reminder is a current view of the ledger, not a new progress record.

Codex and Claude Code retain hook context in history. They read current state after tools/on user prompts but suppresses unchanged text; a changed record or another compaction can emit it again. Hermes projects a fresh advisory onto the final eligible message of each continuation request after compaction. This changes a copied request rather than repeatedly appending to the saved transcript.

The reminder only knows recorded work. If the agent never writes its progress, the ledger can remain stale. Ask it to record meaningful outcomes as work proceeds.

## User steering

The latest owner instructions govern priorities and cancellation. A steer can change the next action while the broader campaign remains active. The lead applies it to the affected package, preserves independent work and returns to outstanding authorized work.

An explicit change to the opening objective/scope may need a new campaign rather than forcing the existing identity to fit. Binding with a different identity returns `CAMPAIGN_IDENTITY_MISMATCH`; inspect the intended assignment instead of retrying the same payload.

## Switch or resume

Call `campaign_unbind` before switching campaigns. Inspect and explicitly bind the new selection. Its reminders activate after compaction under that binding. No reminder is selected merely because a campaign was recently used elsewhere.

New client/server processes start unbound, even when they can see previous campaign records. To resume, repeat discovery, detail, bind and preflight. Bindings are transient; the ledger persists. A clear notice can invalidate old Codex advisory state without deleting historical context already in that conversation.

## Finish deliberately

`campaign_finish` records an evidence-backed finish from the closing gate. FULL closure requires packages to be accepted with current completed evidence, or explicitly cancelled/superseded with reasons. QUALIFIED closure requires named limitations for each unresolved package. `campaign_abandon` preserves an intentionally stopped campaign and its reason.

`campaign_unbind` only clears the session's attachment. It does not finish the campaign, delete its history or reload the plugin. Retired names `campaign_open`, `campaign_resume` and `campaign_close` return guidance for their replacements.

## Tool reference

| Tool | Purpose |
| --- | --- |
| `campaign_list`, `campaign_search` | Discover records while unbound. |
| `campaign_detail` | Inspect opening identity, scope and history. |
| `campaign_create` | Create an owner-approved assignment without binding it. |
| `campaign_bind`, `campaign_unbind` | Attach/detach this conversation. |
| `campaign_status`, `campaign_preflight` | Read current state and declared governance requirements. |
| `campaign_work_package` | Register bounded work. |
| `campaign_receipt`, `campaign_reconcile` | Record evidence and reviewed outcomes. |
| `campaign_update` | Apply a checked lifecycle/phase/package update. |
| `campaign_finish`, `campaign_abandon` | Record deliberate completion or termination. |

In hook mode (Codex and Claude Code) the server also exposes `campaign_context_hook` as a read-only callback for the native hooks. Ordinary work should use the public operations above; the host invokes the callback at the relevant lifecycle events.
