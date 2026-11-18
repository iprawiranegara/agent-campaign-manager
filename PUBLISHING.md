# Publication handoff

The source package, dashboard and npm-installable tarball are prepared locally. Creating a GitHub repository, uploading artifacts, publishing to the npm registry and tagging a release are separate maintainer actions.

Before upload:

- Choose the repository owner/name and replace any release-facing repository URL placeholders if adding clone commands or badges. Current installation instructions work from a downloaded checkout and do not invent a repository URL.
- Review README, both installation guides, the retained MIT notice and the source-provenance note.
- Run `npm test`, `npm run validate`, the Python adapter tests and a clean npm-tarball installation. Preserve optional skips and native platform verification boundaries; run the configured Windows/Linux/macOS CI matrix before claiming it passed.
- Enable a private security-reporting route or update SECURITY.md with the preferred contact.
- Publish only the source files. Generated `.local/` directories, databases, keys and machine configuration are excluded.

The package remains `private: true` in package.json to prevent accidental registry publication. Users can install its `.tgz` with npm before a registry listing exists. Shell and PowerShell wrappers accept that local archive or an explicitly selected HTTPS archive plus SHA-256. No public install URL is invented. Registry publication requires choosing an available npm package identity and intentionally changing the private flag.

The CLI installs the command and prepares standalone adapter files. Native client registration, hook trust and plugin enablement are explicit. This release does not claim automatic remote marketplace/catalog activation.

After upload, link the actual repository and issue/reporting routes, then test the downloaded release archive from a fresh directory before tagging it as stable. Do not promote inherited host-specific evidence into broader platform claims.
