# Campaign dashboard

This is a read-only browser view of a campaign store. It uses Node's built-in HTTP server and SQLite support; production runtime dependencies and a build step are not required. Node.js 24 or newer is required.

## Start from code

The command line interface for this package starts the dashboard. To embed the server in another Node program, import `startDashboard` from `dashboard/src/server.mjs`:

```js
import { startDashboard } from './dashboard/src/server.mjs';

const dashboard = await startDashboard({
  dbPath: '/path/to/campaigns.sqlite3',
  port: 52526,
  projects: [
    { name: 'Workspace', root: '/work/primary', aliases: ['D:\\Work\\Primary'] },
    { name: 'Research', root: '/work/research' },
  ],
});

console.log(`Listening at http://${dashboard.address.address}:${dashboard.address.port}`);
// When the embedding process exits:
await dashboard.close();
```

`dbPath` must name an existing, readable SQLite database. Startup checks its schema and campaign records before listening. On startup failure the returned promise rejects with an actionable error. The dashboard does not create, migrate, repair, or change the database or its permissions. `port` defaults to `52526`; `0` asks the operating system for a free port. The server binds to `127.0.0.1` only. The resolved value has `server`, `address`, `reader`, and an asynchronous `close()` method. Importing the module does not start a listener.

`projects` is optional. Each entry has a display `name`, absolute `root`, and optional `aliases` array of absolute roots. Paths may use POSIX, Windows drive, or UNC syntax. Matching uses path-component boundaries; the longest configured root wins. Thus a parent root includes nested checkouts unless a more specific child root is listed. Windows paths compare without case sensitivity; POSIX paths remain case-sensitive. Repeated roots or names and malformed entries fail before serving requests. The dashboard does not discover roots or read a user's project index.

The reader keeps its nearest-repository or scope attribution in `repositories` for each campaign, and keeps stored `scope_roots` unchanged. The API adds `project_catalog`; its list response also carries those raw attribution fields. The browser derives its display-only groups as `projected_repositories` at list level and on each campaign. A campaign with several project roots appears in each matching group. Unmatched reader groups remain visible beside catalog matches unless they are only a broader Git-root attribution for a scope already matched to a more specific project. If no catalog root matches, the UI groups the campaign by the reader attribution.

`allowedHosts` defaults to `['127.0.0.1', 'localhost']`. Set it explicitly when a trusted local reverse proxy or a different loopback hostname supplies the Host header. Host and Origin checks remain active; binding stays on loopback regardless of the allowlist. Do not put this server directly on a public network.

## Behavior

The server opens a fresh SQLite connection for each read with read-only and query-only modes and a short transaction. It checks the supported schema, opening record, and event/version continuity. Missing or unreadable state, unsupported schemas, stale reads, and integrity failures return redacted errors. It does not replay the complete campaign journal.

The browser refreshes while visible and on request. A failed refresh retains loaded data with a stale warning. It shows separate empty, no-match, initial-error, and detail-error states. Stored campaign text is inserted as text. Dates use the browser's local timezone. Light and dark color schemes, keyboard selection, and narrow mobile layouts are supported. Detail views show exact stored scope paths.

The HTTP surface is limited to GET/HEAD for `/`, `/dashboard.css`, `/dashboard.js`, `/project-catalog.js`, `/api/campaigns`, `/api/campaigns/:id`, and `/health`. Other methods are rejected. Responses use no-store caching, a same-origin content security policy, and standard security headers. Requests with unapproved Host or foreign Origin values are denied.

## Tests

```sh
npm test
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs npm run test:browser
```

The unit tests use disposable campaign databases. Browser verification needs a Playwright installation supplied by the developer; it is not a dashboard dependency. Set `DASHBOARD_EVIDENCE_DIR` to save screenshots outside the source tree.
