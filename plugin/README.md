# Shared core, MCP server and client plugins

This directory contains the shared campaign core (`packages/campaign-core/`), the stdio MCP server (`packages/mcp-server/`), the campaign skills and the plugin manifests. `campaign-manager prepare codex` and `campaign-manager prepare claude` copy it into a standalone installation and generate the client-specific descriptor, manifest and hooks there. The source `.mcp.example.json` is illustrative and is not a configured host connection.

See the repository [README](../README.md), [Codex installation](../docs/install-codex.md), [Claude Code installation](../docs/install-claude.md), [usage](../docs/usage.md) and [architecture](../docs/architecture.md).

The server reads `CAMPAIGN_HARNESS` and `CAMPAIGN_CONTEXT_HOOKS`. In hook mode it exposes a read-only reminder callback and isolates bindings: by native thread metadata for `codex`, by server process for other clients. Without them it keeps the default 14-tool contract used behind the Hermes router. All modes use the same ledger semantics.
