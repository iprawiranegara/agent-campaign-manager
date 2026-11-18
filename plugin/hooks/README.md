# Native bound-campaign reminders

`hooks.json` uses Codex's native MCP-tool hooks on the existing `research-campaign` connection. `SessionStart` matches only `compact`; after that event, `PostToolUse` and `UserPromptSubmit` refresh current bound state. Output is separate model context, capped at 2,000 characters. Original tool output is preserved. Native hook context remains in history, so unchanged reminder text is suppressed; a new compaction emits a fresh reminder even if state is unchanged.

The generated Codex MCP definition sets `CODEX_CAMPAIGN_CONTEXT_HOOKS=1`. In that mode, the server scopes stores/bindings by runtime `_meta.threadId`, overrides model-supplied bind thread metadata and exposes the read-only `campaign_context_hook` callback. The callback never selects a campaign from its arguments or a repository. Default server mode remains the shared 14-tool contract used by Hermes.

Unbound threads emit no campaign data. Unbind, binding switch/loss or terminal state stops refresh and can emit a short notice invalidating earlier reminders. Binding a new campaign requires its own compaction before reminder activation. New server processes start unbound. Reading/refreshing never advances progress or changes campaign version. Failures emit no guessed or foreign campaign context.

Codex must discover and trust the current three hook definitions; changed plugin contents require review. Verify actual compaction and tool boundaries through the intended native consumer. `campaign_bind`/`campaign_unbind` change authorization only and do not reload hooks. `contract.json` remains historical; its other events are not activated.
