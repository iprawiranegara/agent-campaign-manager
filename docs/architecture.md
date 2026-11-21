# Architecture and data boundaries

The shared core is `plugin/packages/campaign-core/`. It uses Node's built-in SQLite implementation with the inherited OMO schema. All adapters call `plugin/packages/mcp-server/src/server.mjs`; campaign rules are implemented once, and the core and tool definitions contain no client-specific code.

```text
Codex native plugin and MCP-tool hooks
  -> thread-scoped MCP sessions
  -> shared campaign core
  -> local SQLite ledger

Claude Code plugin and mcp_tool hooks
  -> one MCP server process per session (per-process identity)
  -> shared campaign core
  -> local SQLite ledger

Hermes native plugin tools and request middleware
  -> existing Hermes MCP client and permissions
  -> authenticated local router, one child server per conversation route
  -> shared campaign core
  -> local SQLite ledger

Browser dashboard
  -> loopback HTTP read API
  -> independent read-only SQLite reader
  -> the same local SQLite ledger
```

## Durable state and transient bindings

The database stores campaigns, work packages, receipts, reviewed outcomes and event history. Expected versions protect writes. An opening identity digest covers immutable fields such as objective, charter, accountable primary and scope. The phase is mutable metadata.

Bindings are in-memory session state. The server's client profile comes from `CAMPAIGN_HARNESS` and `CAMPAIGN_CONTEXT_HOOKS`. Codex scopes stores/tokens by trusted native `_meta.threadId`. Claude Code runs one server process per session, so the server assigns that process an identity (`claude-process-<uuid>`) and ignores model-supplied `thread_id`/`client` on bind. Hermes signs the tool, arguments, route, timestamp and nonce with a per-plugin-process private channel key. Its router rejects forgery, replay and stale binding tokens. The model does not supply the trusted routing identity. These controls separate conversations and profiles within the intended host; another process running as the same OS user is outside that boundary.

## Reminder delivery

Codex and Claude Code enable the reminder callback with `CAMPAIGN_HARNESS=<client>` and `CAMPAIGN_CONTEXT_HOOKS=1` (Codex also accepts the older `CODEX_CAMPAIGN_CONTEXT_HOOKS=1`). Their `SessionStart(compact)` hook activates the current binding; `PostToolUse` and `UserPromptSubmit` read fresh state. A text digest suppresses duplicates retained in native history. Missing identity, unbind, switch, terminal state or a read failure invalidates the active reminder. A new binding requires compaction again.

Hermes uses its runtime compaction event and `llm_request` middleware. For Chat Completions, it appends a labelled advisory to the final existing user message or completed tool result in a copied request. It preserves roles, tool-call IDs, preceding messages and the system prefix. Incomplete tool groups, assistant endings and unsupported content/modes receive no projection. Original transcript messages are not rewritten. A failed read suppresses refresh until another compaction.

Each adapter caps its output at 2,000 characters and refreshes only the exact bound campaign. Reads never advance progress. Stored text and reminders do not override the latest owner instructions.

## Setup and paths

The npm package exposes `campaign-manager`. Its `prepare` commands create standalone installation copies and generate their `.mcp.json` or Hermes configuration fragment with absolute local paths. Generated installations use writable per-user directories outside the npm package. The original `scripts/setup.mjs` interface remains available to source users. Neither path silently edits the host's configuration or approves hooks.

`init` is the explicit schema-initialization operation. The runtime server opens an existing compatible database and rejects missing/incompatible state. Set the same absolute state directory for both adapters when sharing a ledger is intended. The default convention is `$XDG_STATE_HOME/omo-research`, or `~/.local/state/omo-research` when XDG is unset; generated descriptors instead pin the directory explicitly chosen during setup.

The portable Hermes router uses a relative shared-core import. In normal mode, `--state` must match its configured environment/default state directory. Fixture mode also requires an explicit containment root and rejects production state. It forces its child server into the default 14-tool contract by clearing the harness variables, even when a hook profile is set in the parent environment.

## Permissions and failure behavior

The Hermes adapter calls the host's public MCP facade with an explicit per-server allowlist. It does not create a parallel SDK connection or grant blanket MCP access. Router tools stay hidden from model discovery, while the native plugin exposes the public schemas. Writes retain native approval handling.

Known rejected operations report `mutated: false`. Unexpected failures can report an unknown outcome; inspect state before retrying. A router/backend restart loses its bindings. It never silently respawns and replays a stale write. Explicit reset/rebind is required.

## Storage, privacy and backups

Campaign records and paths remain in the selected local state directory. Model requests include the bounded reminder, so that text reaches the client-configured model provider. The package adds no telemetry service or hosted storage.

On POSIX hosts the core restricts state-directory/database permissions; the Hermes adapter requires private channel directories and keys and rejects symlinks. Native Windows uses owner/DACL and reparse checks through the bundled PowerShell helper. POSIX mode bits are not used as proof of Windows ACL security. Keep the database, SQLite WAL/SHM/journal files and snapshots together when backing up; stop writers or use SQLite's supported backup procedure for a consistent copy. Plugin rollback must not silently restore an older ledger over newer work.

The dashboard imports its reader independently of the writer entrypoint. Repository groups are presentation configuration. They do not change a campaign's identity, scope or durable version.
