# Agent installation instructions

Follow this guide when the user gives you this repository and asks you to install Campaign Manager. Carry out the installation and verify it in the requested client.

## Inspect the target

Read the repository instructions and [installation guide](install.md), then inspect the operating system, Node/npm versions, installed client and active profile. Node.js 24+ is required. Use native Windows instructions on Windows.

Install for the client named by the user, or the client you are running in when that is clear. Ask only if the target client or profile is ambiguous. Check existing Campaign Manager registrations, configuration and ledger location before choosing paths. Honor existing state/profile overrides and preserve unrelated configuration.

## Install the command

Inspect `package.json` and the installer for the target platform. Use the release npm archive and verify its published SHA-256. If working from a checkout without a release archive, run `npm pack --ignore-scripts` in the repository and use the archive filename it prints.

Follow [install.md](install.md) to install that archive. The supplied shell/PowerShell wrappers use a per-user npm prefix and print the launcher path; use that path if the command is not on PATH. Check `campaign-manager --version` and `campaign-manager --help`. Resolve missing prerequisites through the user's normal platform setup. Do not invent a registry package or download URL.

## Install the dependencies

Read [dependencies](dependencies.md) and [`dependencies.json`](../dependencies.json). The default `research_delivery` profile expects Superpowers and Co-Researcher in the target client. Check whether each is already installed before adding it. Install missing ones from their upstream repositories at the tested releases using the commands for that client. Never copy their skills into Campaign Manager's own install directory.

Some steps need the user. Hermes blocks the Superpowers plugin until someone accepts its security-scan findings with `--force`; show the user the findings and ask before forcing. Ask before editing a Hermes `skills.external_dirs` list or `~/.codex/AGENTS.md`. If the user declines a dependency, say which profiles won't have their expected skills and suggest `status_only` where that fits.

## Configure and activate the requested client

Select one absolute state directory consistently. Initialize it explicitly with `campaign-manager init --state-dir <absolute-directory>`; retain compatible existing campaigns.

Follow the complete guide for the selected client:

- [Codex](install-codex.md): prepare a stable standalone installation, register its local marketplace/plugin, and complete the native hook review and tool-access steps.
- [Hermes](install-hermes.md): prepare for the actual profile, expose the plugin, merge the generated configuration into existing mappings, then run doctor and enable it through Hermes.

Use the generated paths and printed next actions. Keep client payloads outside temporary directories and the npm cache. Choose a new output directory for an upgrade. Use the host's normal consent flow; report any step that requires a human action. Service restarts and remote exposure need the user's authorization for those actions.

The [dashboard](dashboard.md) uses the same ledger and is available through `campaign-manager dashboard`. Start it when requested; check its printed loopback address and `/health`. Persistent service or tailnet setup is a separate deployment step.

## Verify and report

Verify the plugin in a fresh connection to the actual client: discover its campaign tools and make a read-only `campaign_list` call against the selected ledger. Verify reminders with isolated test state when that is in scope. Keep test campaigns out of the user's ledger. Distinguish command installation, client activation and reminder verification in the result.

Correct an unambiguous input error once. Refresh state once for a version conflict. Stop and check identity mismatches or unknown write outcomes; if recovery fails, report the exact failing command/error and the next action instead of repeatedly guessing.

Report the installed version, client/profile, installation and state paths, verification results, and any remaining human action. Read [compatibility](compatibility.md) before making platform claims. After installation, use [usage.md](usage.md) for campaign operation.
