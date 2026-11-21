# Install for Claude Code

Use a local Claude Code CLI that supports plugin marketplaces and `mcp_tool` hooks. The reference validation uses Claude Code 2.1.330 on Linux with Node.js 24.18.0. Older versions are not certified.

First [install the command](install.md) and the [dependencies](dependencies.md) your campaign profiles need. Superpowers and Co-Researcher both document a Claude Code route in their own READMEs.

## 1. Initialize and prepare

Linux/macOS:

```sh
campaign-manager init
campaign-manager prepare claude --output "$HOME/.local/share/agent-campaign-manager/claude-0.2.0"
claude plugin marketplace add "$HOME/.local/share/agent-campaign-manager/claude-0.2.0"
claude plugin install agent-campaign-manager@campaign-manager
claude plugin list
```

Native Windows PowerShell:

```powershell
$campaignInstall = Join-Path $env:LOCALAPPDATA 'agent-campaign-manager/claude-0.2.0'
campaign-manager init
campaign-manager prepare claude --output $campaignInstall
claude plugin marketplace add $campaignInstall
claude plugin install agent-campaign-manager@campaign-manager
claude plugin list
```

Preparation never overwrites an existing output; choose a new `--output` for an update. Use the same `--state-dir` on `init`, preparation and the dashboard when you select a nondefault ledger.

The generated directory holds `.claude-plugin/marketplace.json` and a standalone plugin with:

- `.claude-plugin/plugin.json`, the plugin manifest;
- `.mcp.json`, which starts `${CLAUDE_PLUGIN_ROOT}/packages/mcp-server/src/server.mjs` with the pinned Node executable and `CAMPAIGN_HARNESS=claude`, `CAMPAIGN_CONTEXT_HOOKS=1` and the selected `CAMPAIGN_STATE_DIR`;
- `hooks/hooks.json`, three `mcp_tool` hooks on `plugin:agent-campaign-manager:research-campaign`;
- the seven campaign skills, listed as `agent-campaign-manager:campaign-*`.

Claude Code copies the plugin into its own cache on install, so the server runs from that copy. Preparation does not edit Claude Code settings.

## 2. How identity works in Claude Code

Claude Code starts one MCP server process per session. In the `claude` profile the server gives that process an identity of the form `claude-process-<uuid>`, and `campaign_bind` records `client: claude`. A binding therefore lasts for one Claude session, and subagents in that session share it. A new session starts unbound. Values the model passes as `thread_id` or `client` cannot override the process identity.

## 3. Verify in a new session

Start a new Claude Code session; sessions that were already running do not load a newly installed plugin. Tools appear as `mcp__plugin_agent-campaign-manager_research-campaign__campaign_*`. Ask the agent to list campaigns; a new ledger returns an empty list.

To check reminders, use a disposable state directory. Approve a test campaign, bind it, run a few tool turns, then run `/compact`. The `SessionStart` hook (matcher `compact`) adds a labelled `[Campaign checkpoint: …]` block for the bound campaign, and `PostToolUse` and `UserPromptSubmit` refresh it when the stored state changes. Unbound sessions receive nothing.

## Updates and removal

Prepare the new version into a new output directory, then:

```sh
claude plugin marketplace remove campaign-manager
claude plugin marketplace add "<new output directory>"
claude plugin install agent-campaign-manager@campaign-manager
```

To remove it:

```sh
claude plugin uninstall agent-campaign-manager@campaign-manager
claude plugin marketplace remove campaign-manager
```

Removal leaves the ledger in place. Every new MCP process starts unbound and needs an explicit rebind.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Tools missing | Start a new session. Check `claude plugin list` and `/mcp` for `plugin:agent-campaign-manager:research-campaign`. |
| Server fails to start | Run the command from `.mcp.json` by hand. The server exits with code 2 and names the problem when the harness variables are inconsistent. |
| Reminders absent | Bind first, then compact. Check `/hooks` for the three plugin hooks. |
| Empty state or wrong campaigns | Check `CAMPAIGN_STATE_DIR` in the generated `.mcp.json`. Regenerate rather than editing the cached copy. |
| `CAMPAIGN_NOT_BOUND` in a new session | Expected: bind the campaign again in that session. |

References: [Claude Code plugins](https://code.claude.com/docs/en/plugins), [hooks](https://code.claude.com/docs/en/hooks), [MCP](https://code.claude.com/docs/en/mcp).
