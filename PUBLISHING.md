# Releasing

Campaign Manager ships as an npm archive attached to a GitHub release. It is not published to the npm registry: `package.json` keeps `"private": true` so that `npm publish` refuses to run. Publishing to the registry would mean choosing an available package name and removing that flag on purpose.

To cut a release:

1. Update the version everywhere it appears: `package.json`, `plugin/package.json`, `plugin/.codex-plugin/plugin.json`, `hermes/plugin.yaml`, the server and router version constants, and the archive names and output paths in the docs (`git grep` the old version to find them). Then run `npm test`, `npm run validate` and `python -m pytest hermes/tests -q`.
2. Push to `master` and wait for the Tests workflow to pass on Windows, Ubuntu, macOS and the browser job. Record any skipped native checks in [compatibility](docs/compatibility.md).
3. Build the archive with `npm pack --ignore-scripts` and record its SHA-256.
4. Install that archive into a disposable npm prefix with lifecycle scripts disabled, then run `campaign-manager --version`, `init` and both `prepare` commands against a scratch state directory.
5. Create a GitHub release with a version tag, attach the archive, and put its SHA-256 in the release notes so the shell and PowerShell installers can verify it.

Publish only source files. Generated `.local/` directories, databases, channel keys and machine configuration stay out of the repository and the archive; `npm run validate` checks the archive's file list.

The CLI installs the command and prepares standalone adapter files. Registering the plugin with a client, trusting its hooks and enabling it remain manual steps in each client.
