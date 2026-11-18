# Hermes adapter

The standalone plugin registers the 14 public campaign operations, conversation-bound compaction hooks and Chat Completions request middleware. Its local router authenticates runtime conversation routes and calls the sibling shared server in `../plugin/`.

Use the repository [Hermes installation guide](../docs/install-hermes.md). Keep this directory beside the shared `plugin/` directory when preparing an installation. Private channel directories belong to the chosen Hermes profile; they are not part of this source tree.

The router retains native MCP permissions and never silently retries a lost write. Fixture mode needs both `--fixture` and `--fixture-root <absolute-scratch-root>` and rejects state outside that root. See [architecture](../docs/architecture.md) and [compatibility](../docs/compatibility.md).
