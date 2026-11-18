import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CampaignError, createStore } from "../packages/campaign-core/src/core.mjs";
import { invokeTool } from "../packages/codex-mcp/src/tools.mjs";

test("two independent writers reject a stale expected version without a second event", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-research-contention-"));
  const scope = join(directory, "scope");
  const dbPath = join(directory, "state", "campaigns.sqlite3");
  await mkdir(scope, { recursive: true });
  const writerA = createStore({ dbPath, allowCreate: true });
  const writerB = createStore({ dbPath });
  const campaign = {
    campaign_id: "contention-campaign",
    objective: "Verify stale-write protection across independent adapters",
    scope_roots: [scope],
    actor: "owner",
    accountable_primary: "owner",
    timestamp: "2026-08-05T00:00:00.000Z",
  };

  try {
    const created = writerA.create(campaign);
    const detailA = writerA.detail(campaign.campaign_id);
    const detailB = writerB.detail(campaign.campaign_id);
    assert.equal(detailA.version, created.version);
    assert.equal(detailB.version, created.version);
    assert.equal(detailA.identity_digest, detailB.identity_digest);

    const sessionA = {};
    const sessionB = {};
    const binding = (detail, runId, threadId) => ({
      campaign_id: campaign.campaign_id,
      expected_version: detail.version,
      identity_digest: detail.identity_digest,
      actor: "owner",
      run_id: runId,
      thread_id: threadId,
    });
    invokeTool(writerA, "campaign_bind", binding(detailA, "writer-a-run", "writer-a-thread"), sessionA);
    invokeTool(writerB, "campaign_bind", binding(detailB, "writer-b-run", "writer-b-thread"), sessionB);

    const accepted = invokeTool(writerA, "campaign_update", {
      expected_version: detailA.version,
      actor: "writer-a",
      lifecycle: "ORIENTING",
    }, sessionA);
    assert.equal(accepted.version, 2);
    assert.equal(accepted.lifecycle, "ORIENTING");

    assert.throws(() => invokeTool(writerB, "campaign_update", {
      expected_version: detailB.version,
      actor: "writer-b",
      lifecycle: "WAITING_OWNER",
    }, sessionB), (error) => {
      assert.equal(error.code, "CAMPAIGN_VERSION_CONFLICT");
      assert.equal(error.details.expected_version, 1);
      assert.equal(error.details.actual_version, 2);
      assert.equal(error.details.mutated, false);
      assert.match(error.details.next_action, /campaign_status/);
      return true;
    });

    const observed = writerB.detail(campaign.campaign_id);
    assert.equal(observed.version, 2);
    assert.equal(observed.lifecycle, "ORIENTING");
    assert.equal(writerB.db.query(
      "SELECT COUNT(*) AS count FROM event WHERE campaign_id = ?",
      [campaign.campaign_id],
    )[0].count, 2);
    const refreshed = invokeTool(writerB, "campaign_status", {}, sessionB);
    const retried = invokeTool(writerB, "campaign_update", { expected_version: refreshed.version, actor: "writer-b", lifecycle: "WAITING_OWNER" }, sessionB);
    assert.equal(retried.version, 3);
    assert.equal(retried.durable_event_count, 3);
  } finally {
    writerA.dispose();
    writerB.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("recoverable errors identify the next safe action without changing campaign state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "campaign-recovery-"));
  const scope = join(directory, "scope");
  await mkdir(scope);
  const store = createStore({ dbPath: join(directory, "state", "campaigns.sqlite3"), allowCreate: true });
  const session = {};
  const call = (name, args = {}) => invokeTool(store, name, args, session);
  const expectError = (fn, code, check) => assert.throws(fn, (error) => {
    assert.equal(error.code, code);
    assert.equal(error.details.mutated, false);
    assert.ok(error.details.next_action);
    check(error);
    return true;
  });
  try {
    const created = call("campaign_create", { campaign_id: "recovery", objective: "Test recovery", scope_roots: [scope], actor: "owner" });
    const binding = { campaign_id: "recovery", expected_version: 1, identity_digest: created.identity_digest, actor: "owner", run_id: "run-1", thread_id: "thread-1" };
    expectError(() => call("campaign_detail", { campaign_id: "nonexistent" }), "CAMPAIGN_NOT_FOUND", (error) => assert.match(error.details.next_action, /campaign_(list|search)/));
    expectError(() => call("campaign_create", { campaign_id: "recovery", objective: "Test recovery", scope_roots: [scope], actor: "owner" }), "CAMPAIGN_ALREADY_EXISTS", (error) => assert.match(error.details.next_action, /campaign_detail/));
    expectError(() => call("campaign_create", { campaign_id: "bad-profile", objective: "Test profile", scope_roots: [scope], actor: "owner", profile: "bad" }), "INVALID_PROFILE", (error) => assert.match(error.details.next_action, /profile/i));
    expectError(() => call("campaign_bind", { ...binding, run_id: "r" }), "INVALID_INPUT", (error) => {
      assert.equal(error.details.field, "run_id");
      assert.match(error.details.expected, /2.*192/);
    });
    expectError(() => call("campaign_bind", { ...binding, identity_digest: "0".repeat(64) }), "CAMPAIGN_IDENTITY_MISMATCH", (error) => assert.match(error.details.next_action, /stop/i));
    expectError(() => call("campaign_bind", { ...binding, expected_version: 0 }), "CAMPAIGN_VERSION_CONFLICT", (error) => assert.match(error.details.next_action, /campaign_detail/));
    call("campaign_bind", binding);
    const before = call("campaign_status");
    expectError(() => call("campaign_receipt", { expected_version: 1, actor: "owner", run_id: "run-1", work_package_id: "missing-work", kind: "test", data: { summary: "done", files_read: ["file"] } }), "WORK_PACKAGE_NOT_FOUND", (error) => assert.match(error.details.next_action, /campaign_status/));
    expectError(() => call("campaign_work_package", { expected_version: 1, actor: "owner", run_id: "run-1", work_package_id: "work-1", title: "test", allowed_paths: ["/etc"] }), "SCOPE_VIOLATION", (error) => assert.match(error.details.next_action, /scope|path/i));
    expectError(() => call("campaign_finish", { expected_version: 1, actor: "owner", run_id: "run-1", closeout: { final_inventory: ["work-1"], limitations: [] } }), "INVALID_TRANSITION", (error) => assert.match(error.details.next_action, /status/i));
    let after = call("campaign_status");
    assert.equal(after.version, before.version);
    assert.equal(after.durable_event_count, before.durable_event_count);
    call("campaign_work_package", { expected_version: 1, actor: "owner", run_id: "run-1", work_package_id: "work-1", title: "test", allowed_paths: [scope] });
    const receipt = { expected_version: 2, actor: "owner", run_id: "run-1", work_package_id: "work-1", kind: "test", data: { summary: "done", artifacts: [{ artifact_id: "artifact", path: join(scope, "file"), risk: "standard" }] } };
    expectError(() => call("campaign_receipt", receipt), "INVALID_INPUT", (error) => assert.deepEqual(error.details.required_fields, ["artifact_id", "path", "risk", "creator"]));
    expectError(() => call("campaign_receipt", { ...receipt, expected_version: 1 }), "INVALID_INPUT", (error) => assert.equal(error.details.field, "data.artifacts[0].creator"));
    after = call("campaign_status");
    assert.equal(after.version, 2);
    assert.equal(after.durable_event_count, 2);
    const valid = { ...receipt, data: { summary: "done", files_read: ["fixture.json"] } };
    expectError(() => call("campaign_receipt", { ...valid, expected_version: 1 }), "CAMPAIGN_VERSION_CONFLICT", (error) => assert.match(error.details.next_action, /campaign_status/));
    const refreshed = call("campaign_status");
    const accepted = call("campaign_receipt", { ...valid, expected_version: refreshed.version });
    assert.equal(accepted.version, 3);
    assert.equal(accepted.durable_event_count, 3);
  } finally {
    store.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a known error during post-commit status never claims the write was rejected", async () => {
  const directory = await mkdtemp(join(tmpdir(), "campaign-post-commit-"));
  const scope = join(directory, "scope");
  await mkdir(scope);
  const store = createStore({ dbPath: join(directory, "state", "campaigns.sqlite3"), allowCreate: true });
  try {
    const created = store.create({ campaign_id: "post-commit", objective: "Test post-commit errors", scope_roots: [scope], actor: "owner" });
    store.bind({ campaign_id: "post-commit", expected_version: 1, identity_digest: created.identity_digest, actor: "owner", run_id: "run-1", thread_id: "thread-1" });
    const originalStatus = store.status.bind(store);
    let statusCalls = 0;
    store.status = (...args) => {
      statusCalls += 1;
      if (statusCalls === 2) {
        throw new CampaignError("STATE_INTEGRITY_ERROR", "post-commit status failed", { mutated: false });
      }
      return originalStatus(...args);
    };
    assert.throws(() => invokeTool(store, "campaign_update", { expected_version: 1, actor: "owner", lifecycle: "ORIENTING" }), (error) => {
      assert.equal(error.code, "STATE_INTEGRITY_ERROR");
      assert.equal(error.details.mutated, true);
      assert.match(error.details.next_action, /inspect/i);
      return true;
    });
    store.status = originalStatus;
    assert.equal(store.status().version, 2);
  } finally {
    store.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
