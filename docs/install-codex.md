# Install for Codex

Use a local Codex CLI/Desktop runtime that supports plugin marketplaces, native MCP tool hooks and thread metadata. The reference validation uses CLI 0.167.0 on Linux with Node.js 24.18.0. Older versions are not certified. This is a local installation, not a hosted ChatGPT or cloud-only plugin.

First [install the command](install.md) and the [dependencies](dependencies.md) your campaign profiles need: Superpowers from the Codex plugin marketplace and Co-Researcher through its upstream Codex bootstrap. State and generated plugin files stay outside the npm package. The commands below use an explicit output directory so the native marketplace command can reference it directly.

## 1. Initialize and prepare

Linux/macOS:

```sh
campaign-manager init
campaign-manager prepare codex --output "$HOME/.local/share/agent-campaign-manager/codex-0.2.0"
codex plugin marketplace add "$HOME/.local/share/agent-campaign-manager/codex-0.2.0" --json
codex plugin add agent-campaign-manager@campaign-manager --json
codex plugin list --json
```

Native Windows PowerShell:

```powershell
$campaignInstall = Join-Path $env:LOCALAPPDATA 'agent-campaign-manager/codex-0.2.0'
campaign-manager init
campaign-manager prepare codex --output $campaignInstall
codex plugin marketplace add $campaignInstall --json
codex plugin add agent-campaign-manager@campaign-manager --json
codex plugin list --json
```

If an output already exists, inspect it and choose another `--output`; preparation does not overwrite an installation. Use the same `--state-dir` on `init`, preparation and the dashboard when selecting a nondefault ledger. Initialization retains compatible campaigns and rejects incompatible schemas. Plugin upgrades do not require restoring an older database.

The generated directory contains a standalone plugin and `.agents/plugins/marketplace.json`. Its MCP descriptor pins the selected Node executable, working directory and state, and sets `CAMPAIGN_HARNESS=codex` with `CAMPAIGN_CONTEXT_HOOKS=1`. Keep that directory in place while Codex uses it. From an extracted source tree the original `node scripts/setup.mjs init|codex|claude|hermes --state-dir ... --output ...` interface is also available.

## 2. Install through Codex

The marketplace is named `campaign-manager` and the plugin `agent-campaign-manager`. Releases before this change used the plugin name `codex-research-campaign`; remove that registration before installing the renamed plugin, and review its hooks again. The ledger is unaffected.

Desktop users can install from the generated local marketplace through the Plugins interface. Refresh the local plugin sources when needed. The installed plugin must belong to the Codex profile used by that desktop connection.

## 3. Review hooks and tool access

Open `/hooks` in Codex CLI, or **Settings > Hooks** / **Review hooks** in Desktop. Review and trust the plugin's current definitions for:

- `SessionStart` with source `compact`;
- `PostToolUse`;
- `UserPromptSubmit`.

Plugin installation does not approve its hooks. Updated plugin contents can require another review even if the declarations look the same. Setup does not bypass that review. If hooks are disabled by your own configuration, enable the supported `hooks` feature through your normal configuration process; managed policy can still restrict it.

Keep the normal MCP tool permission policy. Authorize the campaign operations you intend to use when Codex requests approval. An automatic-approval policy that rejects a call can prevent use even when discovery succeeds.

## 4. Verify in a fresh conversation

Start a new conversation or reconnect the MCP server. Ask the agent to list campaigns; a new ledger should return an empty list. Then explicitly approve a disposable campaign, inspect its identity, bind it, and read status/preflight.

With the campaign bound, perform a few benign tool turns and compact the conversation. The next continuation should receive a labelled reminder for that campaign. It must contain no other campaign's state. Tools themselves remain visible before binding; reminders stay inactive until the bound conversation has compacted.

Refresh checks run after tools and on user prompts. Unchanged text is suppressed because native context remains in the history. Changed state and a new compaction can emit fresh context. The original tool result is preserved.

## Updates and removal

Prepare an updated installation into a new output directory, point the local marketplace to that copy, and reinstall using the native plugin commands. Review the changed source and hooks before use. Verify discovery and a disposable compaction/tool cycle again. Keep the ledger separate from generated installation directories.

```bash
codex plugin remove agent-campaign-manager@campaign-manager
codex plugin marketplace remove campaign-manager
```

These commands remove plugin registration/cache, not your ledger. Preserve the state directory unless you intentionally want to delete its campaigns. Every replaced MCP process starts unbound and needs an explicit rebind.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Plugin not found | Use the generated marketplace directory and the matching marketplace name. Check the active Codex profile. |
| Tools available, reminders absent | Check hook trust, whether hooks are enabled, the current binding and whether compaction has occurred since that binding. |
| `CAMPAIGN_RUNTIME_IDENTITY_REQUIRED` | The caller did not supply native thread metadata. Use the supported Codex host connection. |
| Empty state or wrong campaigns | Check the state directory in the generated `.mcp.json`. Regenerate instead of guessing another ledger. |
| `CAMPAIGN_NOT_BOUND` after reload | Inspect the selected campaign and bind the fresh connection. |
| Hook reports modified contents | Review and trust the current installed plugin; do not copy old trust hashes. |

Installation format: [official plugin packaging](https://developers.openai.com/plugins/build/plugins). Hook lifecycle and review: [official hooks documentation](https://learn.chatgpt.com/docs/hooks).
