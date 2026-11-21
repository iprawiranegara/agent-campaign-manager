import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createStore } from "../packages/campaign-core/src/core.mjs";
import { invokeTool } from "../packages/mcp-server/src/tools.mjs";

const packageRoot = join(import.meta.dirname, "..");
const omoToolsPath = process.env.OMO_TOOLS_PATH;

function runOmo(dbPath, stateDir, scope) {
  const script = `
    import { join } from "node:path";
    import { createCampaignRuntime, createCampaignTools } from ${JSON.stringify(omoToolsPath)};
    const dbPath = ${JSON.stringify(dbPath)};
    const stateDir = ${JSON.stringify(stateDir)};
    const scope = ${JSON.stringify(scope)};
    const runtime = createCampaignRuntime({
      paths: {
        database: dbPath,
        journalDirectory: join(stateDir, "journal") + "/",
        snapshotsDirectory: join(stateDir, "snapshots") + "/",
      },
      now: () => "2026-08-05T00:00:00.000Z",
    });
    const tools = createCampaignTools(runtime);
    const context = { sessionID: "omo-interop-session", messageID: "interop-message", agent: "primary", directory: scope, worktree: scope, abort: new AbortController().signal, metadata() {}, ask: async () => {} };
    const detail = JSON.parse(await tools.campaign_detail.execute({ campaign_id: "interop-campaign" }, context));
    await tools.campaign_bind.execute({ campaign_id: "interop-campaign", expected_version: detail.version, identity_digest: detail.identity_digest, actor: "owner", run_id: "omo-run", thread_id: "omo-thread" }, context);
    const updated = JSON.parse(await tools.campaign_update.execute({ expected_version: detail.version, actor: "owner", operation: "transition", lifecycle: "ORIENTING" }, context));
    const status = JSON.parse(await tools.campaign_status.execute({}, context));
    runtime.store.close();
    process.stdout.write(JSON.stringify({ updated, status }));
  `;
  return spawnSync("bun", ["--eval", script], { cwd: packageRoot, encoding: "utf8" });
}

function readOmo(dbPath, stateDir) {
  const script = `
    import { join } from "node:path";
    import { createCampaignRuntime } from ${JSON.stringify(omoToolsPath)};
    const runtime = createCampaignRuntime({
      paths: {
        database: ${JSON.stringify(dbPath)},
        journalDirectory: join(${JSON.stringify(stateDir)}, "journal") + "/",
        snapshotsDirectory: join(${JSON.stringify(stateDir)}, "snapshots") + "/",
      },
    });
    const record = runtime.store.readCampaign("interop-campaign");
    runtime.store.close();
    process.stdout.write(JSON.stringify(record));
  `;
  return spawnSync("bun", ["--eval", script], { cwd: packageRoot, encoding: "utf8" });
}

test("Codex and OMO adapters observe and mutate one OMO campaign database", async (t) => {
  if (!omoToolsPath) { t.skip("Set OMO_TOOLS_PATH to an external OMO adapter tools.ts for optional interoperability verification"); return; }
  const bunCheck = spawnSync("bun", ["--version"], { encoding: "utf8" });
  if (bunCheck.error?.code === "ENOENT") {
    t.skip("Bun is required for the cross-client OMO adapter test");
    return;
  }
  assert.equal(bunCheck.status, 0, bunCheck.stderr || bunCheck.stdout);
  const directory = await mkdtemp(join(tmpdir(), "campaign-interop-"));
  const stateDir = join(directory, "state");
  const scope = join(directory, "scope");
  await mkdir(scope, { recursive: true });
  const dbPath = join(stateDir, "campaigns.sqlite3");
  const fallbackPath = join(homedir(), ".local", "state", "research-campaign");
  const fallbackExisted = existsSync(fallbackPath);
  const store = createStore({ dbPath, allowCreate: true });
  try {
    const created = store.create({
      campaign_id: "interop-campaign",
      objective: "Verify cross-client campaign continuity.",
      scope_roots: [scope],
      actor: "owner",
      accountable_primary: "owner",
      timestamp: "2026-08-05T00:00:00.000Z",
    });
    assert.equal(created.version, 1);

    const before = store.detail("interop-campaign");
    const result = runOmo(dbPath, stateDir, scope);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const omo = JSON.parse(result.stdout);
    assert.equal(omo.updated.version, 2);
    assert.equal(omo.status.status, "ORIENTING");

    const observed = store.detail("interop-campaign");
    assert.equal(observed.version, 2);
    assert.equal(observed.lifecycle, "ORIENTING");
    assert.equal(observed.identity_digest, before.identity_digest);

    const session = {};
    const unbound = () => invokeTool(store, "campaign_status", {}, session);
    assert.throws(unbound, (error) => error.code === "CAMPAIGN_NOT_BOUND");
    const bound = invokeTool(store, "campaign_bind", {
      campaign_id: "interop-campaign",
      expected_version: observed.version,
      identity_digest: observed.identity_digest,
      actor: "owner",
      run_id: "codex-run",
      thread_id: "codex-thread",
    }, session);
    assert.equal(bound.version, 2);
    const status = invokeTool(store, "campaign_status", {}, session);
    assert.equal(status.lifecycle, "ORIENTING");
    assert.equal(status.campaign_id, "interop-campaign");
    assert.equal(store.detail("interop-campaign").version, 2);
    const codexUpdate = invokeTool(store, "campaign_update", {
      expected_version: 2,
      actor: "owner",
      operation: "transition",
      lifecycle: "READY",
    }, session);
    assert.equal(codexUpdate.version, 3);
    const omoRead = readOmo(dbPath, stateDir);
    assert.equal(omoRead.status, 0, omoRead.stderr || omoRead.stdout);
    const omoRecord = JSON.parse(omoRead.stdout);
    assert.equal(omoRecord.version, 3);
    assert.equal(omoRecord.lifecycle, "READY");
    assert.equal(existsSync(fallbackPath), fallbackExisted);
  } finally {
    store.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
