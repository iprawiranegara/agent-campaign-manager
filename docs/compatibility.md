# Compatibility and verification

## Supported installation target

The 0.2.0 release targets native Windows, Linux and macOS. Node 24+ is the baseline. The verification record below separates GitHub Actions runs from native host runs. There are no npm runtime dependencies. Python is supplied by the Hermes installation; `pytest` is a development dependency only.

| Surface | Verified boundary |
| --- | --- |
| Shared core | SQLite identity/version rules, receipts, reconciliation and finish protections in the included Node suite. |
| Codex | Local plugin marketplace and native hooks with CLI/app-server 0.167.0. |
| Hermes | Native general-plugin APIs at Linux source revision `cb224ae2ffcd2b91f041fa1cf6333e05a2176261`, plus isolated router/bridge/reminder tests. Windows host verification is recorded below. |
| Providers | No provider-specific API key is required by this package. Reminder text uses the provider already configured in the host. |

Codex must support native `_meta.threadId` forwarding and MCP-tool hooks. Hermes must expose the documented general-plugin SDK and runtime metadata. Install discovery alone does not prove those paths.

Native Windows channel protection uses Windows PowerShell 5.1+ and NTFS ownership/access-control APIs. Linux and macOS retain POSIX permission checks. An insecure channel directory/key or failed security check rejects dispatch. The shared core rejects paths outside scope using native path separators.

CI covers the package on all three systems. Native client SDK tests also need compatible local Hermes/Codex installations, so they ran only on the hosts listed below.

## 0.2.0 verification record

GitHub Actions, run on Windows Server 2025, Ubuntu and macOS (arm64) with Node 24.22 and Python 3.12. Each job runs the tests in the source tree, then packs the npm archive, installs it outside the source tree and repeats the tests and validation from the installed copy:

| Boundary | Observed result |
| --- | --- |
| Ubuntu and macOS | 88 Node tests: 86 passed, zero failed, two skips (Windows-only installer check, external OMO adapter). Hermes suite: 33 passed, six skips. Installed archive initialized a ledger and prepared a Codex installation. |
| Windows | 88 Node tests: 84 passed, zero failed, four skips (two POSIX shell-installer checks, the symlinked-path check, external OMO adapter). Hermes suite: 33 passed, six skips. Installed archive initialized a ledger and prepared a Codex installation. |
| Dashboard browser (Ubuntu, Chromium) | Playwright acceptance script passed. |

Native host runs during preparation, on an earlier revision of the test suite:

| Boundary | Observed result |
| --- | --- |
| Linux, Node 24.18.0 | 84 tests: 82 passed, zero failed, two platform/external skips. |
| Native Windows, Node 24.19.0, installed npm archive | 84 tests: 81 passed, zero failed, three platform/external skips; package validation passed. Includes dashboard startup/read-only reads and generated Codex/Hermes setup. |
| Native Windows Codex 0.169.0-alpha.11.1 | Version 0.2.0 installed/enabled in a disposable profile; native app-server connected, discovered `campaign_list` and read an empty synthetic ledger. No model turn, interactive UI hook approval or compaction was tested. |
| Shared-core Windows scope regression | Failed before correction, passed after it; outside-scope sibling is rejected without mutation. |
| Dashboard browser | Filters/details, catalog grouping, safe stored text, stale/race recovery, 1280/768/320 geometry, light/dark and viewer-local dates passed. |
| Linux Hermes suite with the native SDK enabled | 34 passed, zero failed, four Windows-only skips. |
| Linux native Hermes SDK | Both native dispatch/consent/identity and loaded-plugin compaction/middleware checks passed with synthetic state. |
| Install entry points | Actual POSIX shell and native PowerShell installs passed with a local checksum-verified archive, followed by cache removal, explicit init and both client preparations. |
| Native Windows Hermes suite, Python 3.12.15 and PowerShell 5.1 | 32 passed, zero failed, six skips (two optional host SDK integrations and four POSIX-only checks). Includes signed routing, key creation/cleanup, ACL and junction rejection, replay/identity isolation and refusal to repair a nonempty insecure key. |
| Native Windows Hermes SDK, 0.23.2+314.g23fbfbf with its existing Python 3.14.9 environment | Both native dispatch/consent/identity and loaded-plugin compaction/middleware tests passed with synthetic state. The host's managed environment supplies its dependencies; no production profile or package installation was changed. |
| macOS | Covered by CI only. Native Hermes and Codex client runs on macOS have not been done. |

Windows tests used a new private per-user temporary root. On the Windows test host the default temporary folder granted write access to other users, so the channel helper rejected it, as designed. Existing directory permissions were left unchanged. The check does not guarantee that a shared folder you choose yourself is secure.

Native component checks are separate from enabling the plugin in an existing desktop conversation.

## Reminder modes

Codex uses native local hook context after compaction/tools. It does not append inside the original tool result. Hosted cloud-only execution and generic MCP clients without native thread identity are not certified.

Hermes projects reminders only for `chat_completions`. It preserves final existing user/tool roles. `anthropic_messages` and `codex_responses` currently receive no reminder. An Anthropic model routed through a Chat Completions gateway can use the supported projection; the model name alone does not establish the request format.

A binding must already exist when compaction occurs. New or changed bindings require a subsequent compaction before reminders activate. Fresh processes require explicit rebind. The package does not reattach silently from a repository path.

## Test interpretation

`npm test` runs the included core, MCP, native-thread isolation and setup tests. The external OMO interoperability check is skipped unless `OMO_TOOLS_PATH` and Bun are provided. The OMO adapter is not bundled; that skip does not establish cross-client interoperability.

`python -m pytest hermes/tests -q` runs the self-contained adapter checks and skips native Hermes integrations when `HERMES_SOURCE` is absent. Supplying the matching checkout/runtime enables those integrations. See [contributing](../CONTRIBUTING.md).

The native client checks for 0.2.0 used isolated profiles, synthetic campaigns and a deterministic local model provider. It checks actual hook/compaction/tool boundaries and context delivery. It does not prove that a model will consistently obey reminders or complete an unattended campaign. The core validates evidence structure, not the truth of every recorded claim.
