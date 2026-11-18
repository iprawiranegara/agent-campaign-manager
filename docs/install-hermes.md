# Install for Hermes

The Hermes adapter is a native standalone plugin plus a local stdio MCP router. It targets native Windows, Linux and macOS with Node.js 24+, and a Hermes build exposing general plugins, `ctx.call_mcp`, explicit MCP allowlists, runtime conversation IDs, `llm_request` middleware and committed-compaction hooks. See [compatibility](compatibility.md) for the tested source revision. A Hermes version number alone is insufficient if that build lacks these APIs.

First [install the command](install.md) and the [dependencies](dependencies.md) your campaign profiles need: Superpowers as a Hermes plugin and Co-Researcher as an external skill directory. Select the profile used by the actual consuming Hermes process. `HERMES_HOME` overrides the platform default: `~/.hermes` on POSIX and `%LOCALAPPDATA%\hermes` on current native Windows. Older or custom installations can use another path; pass it explicitly.

## 1. Initialize and prepare

Linux/macOS:

```sh
export HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
campaign-manager init
campaign-manager prepare hermes --hermes-home "$HERMES_HOME" --output "$HOME/.local/share/agent-campaign-manager/hermes-0.2.0"
```

Native Windows PowerShell:

```powershell
if (-not $env:HERMES_HOME) { $env:HERMES_HOME = Join-Path $env:LOCALAPPDATA 'hermes' }
$campaignInstall = Join-Path $env:LOCALAPPDATA 'agent-campaign-manager/hermes-0.2.0'
campaign-manager init
campaign-manager prepare hermes --hermes-home $env:HERMES_HOME --output $campaignInstall
```

Preparation prints the plugin path, selected profile channel directory and `config.fragment.json` path. It prepares private channels using POSIX permissions or Windows ACLs as appropriate. On POSIX, every existing folder on the channel path must be writable only by you. Preparation refuses a folder that the group or other users can write, and it never changes existing permissions itself. It does not merge your config or enable the plugin. Existing outputs are preserved; choose a new `--output` for an upgrade. Use the same explicit `--state-dir` for both clients if sharing an existing ledger.

## 2. Expose the plugin to the selected profile

On Linux/macOS, link the prepared plugin:

```sh
mkdir -p "$HERMES_HOME/plugins"
test ! -e "$HERMES_HOME/plugins/campaign-manager" && test ! -L "$HERMES_HOME/plugins/campaign-manager" && ln -s "$HOME/.local/share/agent-campaign-manager/hermes-0.2.0/hermes" "$HERMES_HOME/plugins/campaign-manager"
```

On Windows, copy the plugin directory; no developer mode or symbolic-link privilege is needed:

```powershell
$campaignPlugin = Join-Path $env:HERMES_HOME 'plugins/campaign-manager'
if (Test-Path -LiteralPath $campaignPlugin) { throw 'Inspect the existing campaign-manager plugin before replacing it.' }
New-Item -ItemType Directory -Force -Path (Split-Path $campaignPlugin) | Out-Null
Copy-Item -LiteralPath (Join-Path $campaignInstall 'hermes') -Destination $campaignPlugin -Recurse
```

Keep the generated installation's `plugin/` and `hermes/` directories together. The router configuration points to that installation; the profile copy contains the native Python plugin. Updates must switch the plugin and router configuration together.

## 3. Merge the generated configuration

Open `config.fragment.json` in the generated installation directory and merge its contents into `$HERMES_HOME/config.yaml`. JSON values can be transcribed as YAML; preserve existing entries and merge into the existing top-level mappings rather than replacing them.

The fragment supplies these two narrow sections:

```yaml
plugins:
  entries:
    campaign-manager:
      mcp_allowlist: [campaign-router]
      settings:
        channel_dir: /absolute/profile/plugin-data/campaign-manager/channels

mcp_servers:
  campaign-router:
    command: /absolute/path/to/node
    args:
      - /absolute/install/hermes/router.mjs
      - --channels
      - /absolute/profile/plugin-data/campaign-manager/channels
      - --state
      - /absolute/state/omo-research
    cwd: /absolute/install
    env:
      CODEX_RESEARCH_CAMPAIGN_STATE_DIR: /absolute/state/omo-research
    trust: untrusted
    tools:
      include: []
    resources: false
    prompts: false
    sampling: false
    lazy: false
```

Use the actual generated paths, not the illustrative `/absolute/...` values. The router's `--state` and environment state directory must match. The channel directory must match the plugin's `channel_dir` for that profile.

The allowlist grants this plugin access only to `campaign-router`. Keep raw router tools hidden (`include: []`) and the server untrusted. Native Hermes approval remains responsible for write consent. A wildcard allowlist is not needed.

## 4. Validate and enable

```bash
hermes plugins doctor /absolute/generated-install/hermes --ci
hermes plugins enable campaign-manager --no-allow-tool-override
```

Use the actual printed plugin path for `doctor` (on Windows, `(Join-Path $campaignInstall 'hermes')`). Use the plugin toolset in your selected platform's tool configuration if that platform uses an explicit toolset selection. This plugin declares the `campaign` toolset; native enablement should preserve existing selections. Confirm its 14 tools appear in a fresh conversation.

## 5. Activate in the process you use

A dashboard and a messaging gateway can load plugins in separate processes. Reload the plugin in the actual consuming process, or restart that client using its normal administrative procedure. A gateway reload does not activate new code in an already-running dashboard.

Reloading releases that plugin process's bindings. Saved conversations and campaign records remain on disk; inspect and rebind the selected campaign afterward. Coordinate a live service restart with its operator.

## 6. Verify a disposable conversation

List campaigns, explicitly create or choose one, inspect its identity and bind the conversation. Read status and preflight. Confirm an unbound second conversation receives no reminder.

Use the Chat Completions request mode, complete a few benign tool turns and compact the bound conversation. After committed compaction, the next eligible request should contain the labelled advisory on its final user message or completed tool result. The role and original tool-call ID are preserved. Reads refresh current state; they do not create progress events.

Anthropic Messages and Codex Responses projections are not implemented. The request middleware remains silent for those modes. Provider/model labels do not determine the request mode, so check the actual Hermes API mode.

## Updates and removal

Prepare an updated copy, review it, update the selected profile's plugin link and router configuration together, then validate and reload that consumer. Back up the ledger independently. Never replace it with test data.

To stop using the adapter, disable `campaign-manager` through Hermes, remove only its allowlist/settings and `campaign-router` registration, then remove the plugin link and generated installation after it is no longer in use. Keep the ledger unless deleting campaign history is intentional.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| MCP access denied | `plugins.entries.campaign-manager.mcp_allowlist` must contain only the intended router name. |
| `prepare hermes` reports a channel path that is not private | A folder under `$HERMES_HOME/plugin-data` is group- or world-writable, often because of a `umask` of `0002`. Inspect it with `ls -ld`; if you own it and nothing else needs shared write access, `chmod go-w` it and retry. |
| Superpowers plugin install is blocked | Hermes's install scan blocks community plugins by default. Review the findings and repeat the command with `--force` if you accept them. See [dependencies](dependencies.md). |
| Routing authentication fails | Match plugin/router channel directories and profile ownership; inspect permissions rather than bypassing them. |
| `ADAPTER_BINDING_LOST` | Inspect current state, clear the stale binding and bind explicitly. Do not replay an uncertain write. |
| Tools absent in dashboard | Validate and reload the dashboard's actual profile/process and check its selected toolsets. |
| Compaction but no reminder | Check binding, committed message removal, request mode and which process loaded the plugin. |

Official host APIs: [Hermes plugins](https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins/) and [request middleware](https://hermes-agent.nousresearch.com/docs/developer-guide/middleware/).
