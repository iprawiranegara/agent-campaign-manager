# Install the command

Install Node.js 24+ using your normal platform installer. Hermes and Codex are separate applications. Campaign Manager does not install or update them.

The default campaign profile also expects [Superpowers](https://github.com/obra/superpowers) and [Co-Researcher](https://github.com/poemswe/co-researcher) in the client. Install them from upstream using [dependencies](dependencies.md), or use the `status_only` profile, which needs neither.

## npm archive: Windows, Linux and macOS

Build `agent-campaign-manager-0.2.0.tgz` from a clone with `npm pack --ignore-scripts`, or download it with its SHA-256 from a [GitHub release](https://github.com/iprawiranegara/agent-campaign-manager/releases). From the directory that holds the archive:

```sh
npm install --global --ignore-scripts ./agent-campaign-manager-0.2.0.tgz
campaign-manager --version
campaign-manager init
```

PowerShell accepts the same commands; `campaign-manager.cmd` is available if the local PowerShell script policy blocks npm's `.ps1` shim. Use a user-writable npm installation. This package does not need administrator access or a changed system execution policy.

The package isn't on the npm registry, so `npm install agent-campaign-manager` by name does not work. Install from the archive file.

## Downloaded shell or PowerShell installer

The wrappers install the same npm archive with lifecycle scripts disabled. They require Node/npm already installed. They install into a user-owned npm prefix and print the full launcher path without changing PATH. On POSIX that prefix is under `XDG_DATA_HOME` or `~/.local/share/omo-research/npm`; on Windows it is under `%LOCALAPPDATA%\omo-research\npm`. Use the printed path until its bin directory is on your PATH. They do not initialize a ledger, configure a client or start a service.

Linux/macOS, from a source or downloaded installer directory:

```sh
sh install/install.sh ./agent-campaign-manager-0.2.0.tgz
```

Windows PowerShell:

```powershell
& ./install/install.ps1 -Source ./agent-campaign-manager-0.2.0.tgz
```

Both accept an HTTPS archive URL, such as a release asset. Supply the SHA-256 from the release through `--sha256` or `-Sha256`; URL downloads require a checksum. Download and inspect an installer using `curl` or `Invoke-WebRequest`, then run the downloaded file. Don't pipe an installer into `Invoke-Expression`.

## Prepare the clients

```sh
campaign-manager prepare codex
campaign-manager prepare hermes
```

Each prints its generated locations and the next activation steps. The files are standalone; keep their directories in place while the client uses them. Follow the [Codex](install-codex.md) and [Hermes](install-hermes.md) guides to review configuration and activate the plugin.

## State selection

All CLI commands use the same order:

1. Explicit `--state-dir`.
2. `CODEX_RESEARCH_CAMPAIGN_STATE_DIR`.
3. `XDG_STATE_HOME` plus `omo-research`.
4. The user's home directory plus `.local/state/omo-research`.

Use an absolute path. Generated client descriptors pin the selected path. `init` is explicit; opening the dashboard or preparing a client never invents another database. Sharing a ledger is supported for clients on the same host. Cross-machine file synchronization and translated scope identities are outside this package.

## Update or remove

Install the newer npm archive and prepare each client into a new output directory. Review and switch its native registration to that directory, then verify a disposable conversation. Removing the command with `npm uninstall --global agent-campaign-manager` does not remove generated client installations or the ledger. Disable those registrations through the host before deleting an installation directory. Keep campaign history unless its deletion is intentional.
