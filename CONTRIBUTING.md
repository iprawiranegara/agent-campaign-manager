# Contributing

Keep campaign semantics in the shared core. Adapter changes should preserve explicit binding, native runtime identity, current-campaign isolation, read-only refresh and the 2,000-character reminder cap.

Use Node.js 24+ and a separate Python development environment with pytest. No npm install is needed for runtime dependencies.

```bash
npm test
npm run validate
python -m pytest hermes/tests -q
```

For native Hermes integration, point `HERMES_SOURCE` at the matching source checkout and run pytest with its test-capable Python environment. `HERMES_PYTHON` can select that interpreter for spawned subprocesses. `CAMPAIGN_NODE` can select the absolute Node executable. Do not aim tests at an active profile or production database.

```bash
HERMES_SOURCE="/path/to/hermes-agent" HERMES_PYTHON="/path/to/hermes-test-python" CAMPAIGN_NODE="/path/to/node" /path/to/hermes-test-python -m pytest hermes/tests -q
```

For the optional external OMO interoperability test, set `OMO_TOOLS_PATH` to that adapter's `src/tools.ts` and make Bun available. The test uses a temporary database. A missing input is a reported skip.

For reminder changes, test actual compaction and model/tool continuation in an isolated native consumer. Confirm that an unbound second conversation stays silent, state changes refresh the correct reminder, and unbinding invalidates it. Report whether the provider was deterministic or a real model. Do not equate model-context delivery with guaranteed behavior.

The Node command also covers dashboard and setup/CLI tests. Run the browser acceptance script with an installed Playwright module selected through `PLAYWRIGHT_MODULE`; it is a development dependency, not a runtime dependency. Test a clean npm tarball installation with lifecycle scripts disabled, using a disposable npm prefix and state directory.

Channel tests require a temporary root whose ancestors are not writable by another user; a system sticky temporary directory is suitable. If a shell sets `TMPDIR` to a group-writable custom directory, select a private temporary root for the test run. Do not change production directory permissions just to make fixtures pass.

Windows channel tests must exercise real NTFS ACLs, including rejection of broad/inherited permissions and reparse points; POSIX mode projections are insufficient. Keep cross-platform test paths native and test both outside-scope siblings and spaces/Unicode. CI has Windows, Ubuntu and macOS jobs. Record which native jobs actually ran.

Never commit generated `.local/` installations, credentials, state databases, channel keys or operational transcripts. Run validation before packaging. Review the archive manifest as well as the source diff.

The package uses no third-party runtime code. Before adding any, such as an MCP SDK, check that its license is compatible with MIT and add it to both third-party notices.
