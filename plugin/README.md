# Codex adapter and shared core

This directory contains the Codex plugin's manifest, skills, hooks, MCP server and shared campaign core. Generate a local installation descriptor before installing it; the source `.mcp.example.json` is illustrative and is not a configured host connection.

See the repository [README](../README.md), [Codex installation](../docs/install-codex.md), [usage](../docs/usage.md) and [architecture](../docs/architecture.md).

The opt-in native Codex server exposes a read-only reminder callback and isolates bindings by runtime thread metadata. Its default 14-tool contract is retained for the Hermes router. Both modes use the same ledger semantics.
