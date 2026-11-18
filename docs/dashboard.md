# Web dashboard

The dashboard reads the ledger used by the adapters. It shows stored campaign status, work packages, decisions, open gates/risks and recent events. Stored status does not prove an agent is currently running.

After [installation](install.md) and explicit ledger initialization:

```sh
campaign-manager dashboard
```

Open the printed loopback address in a browser on that machine. `--port` selects another port, and `--state-dir` selects the same absolute ledger directory supplied to client preparation. A missing or incompatible store stops startup; the dashboard does not create or migrate a database.

## Parent repository groups

Without configuration, the dashboard uses repository/scope attribution from the reader. To group nested checkouts under a parent, create `projects.json`:

```json
[
  {
    "name": "Research",
    "root": "/workspace/research",
    "aliases": ["D:/Projects/research"]
  }
]
```

Then run:

```sh
campaign-manager dashboard --projects ./projects.json
```

The catalog is an array with a display `name`, absolute `root` and optional absolute `aliases`. Whole path segments determine membership, so a similarly named sibling does not match a parent. Windows drive/UNC paths match without case sensitivity; POSIX paths retain case sensitivity. When configured roots overlap, the most specific configured root wins. A campaign can appear under multiple distinct projects. The UI deduplicates membership, while details preserve exact recorded scope paths and raw repository attribution. Unmatched unrelated scopes retain their reader attribution. When a configured project lies inside a broader Git repository, that outer repository does not become a duplicate group for the same matched scope.

Keep the catalog outside the installed npm package so upgrades preserve it. No user-specific catalog ships with the release.

## Read-only and network boundaries

The server opens SQLite read-only with query-only mode and short transactions. It serves the named static assets and read APIs, rejects mutation methods, checks request Host/Origin and sends same-origin security headers. Stored text is rendered as text. Visible pages refresh periodically; failures preserve the last snapshot with a warning, and late responses cannot replace a newer selection.

The CLI binds `127.0.0.1`. This release does not install a service, configure Tailscale or expose a public site. An operator integrating an authenticated reverse proxy can use the documented server API with an explicit hostname allowlist; that proxy and its access policy are separate from this package.

The dashboard cannot prove the truth of a stored evidence receipt or replay the entire event journal. The parent agent remains responsible for reviewing evidence and recording outcomes through the campaign tools.
