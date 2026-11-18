import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CampaignError, createStore } from "../packages/campaign-core/src/core.mjs";
import { CampaignSqliteError, openSqlite } from "../packages/campaign-core/src/sqlite.mjs";

async function withStore(callback) {
  const directory = await mkdtemp(join(tmpdir(), "codex-research-campaign-"));
  const scope = join(directory, "scope");
  await mkdir(scope);
  const store = createStore({ stateDir: join(directory, "state"), allowCreate: true });
  try {
    await callback({ directory, scope, store });
  } finally {
    store.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}

function contract(scope) {
  return {
    campaign_id: "campaign-alpha",
    objective: "Govern a durable research delivery campaign",
    scope_roots: [scope],
    actor: "owner",
    accountable_primary: "owner",
    profile: "research_delivery",
    charter: {
      required_authorities: ["AGENTS.md", "docs/project-state.md"],
      protected_state: ["raw-sources", "published-output"],
    },
  };
}

async function withSqlite(callback) {
  const directory = await mkdtemp(join(tmpdir(), "codex-research-sqlite-"));
  const path = join(directory, "state", "campaigns.sqlite3");
  const database = openSqlite({ path, allowCreate: true });
  try {
    await callback({ directory, path, database });
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("state adapter opens only an existing production database and creates OMO schema explicitly for fixtures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-research-sqlite-missing-"));
  const path = join(directory, "state", "campaigns.sqlite3");
  try {
    assert.throws(() => openSqlite({ path }), (error) => error instanceof CampaignSqliteError && error.code === "CAMPAIGN_DATABASE_MISSING");
    assert.equal(existsSync(path), false);

    const database = openSqlite({ path, allowCreate: true });
    try {
      assert.deepEqual(database.validateSchema().version, 1);
      assert.equal(database.validateSchema().checksum, "omo-research-campaign-schema-v1-fix1");
      assert.ok(database.validateSchema().tables.includes("campaign"));
      assert.equal(existsSync(join(directory, "research-campaign", "campaigns.sqlite3")), false);
    } finally {
      database.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("state adapter binds parameters, commits and rolls back, keeps WAL sidecars private, and closes", async () => {
  await withSqlite(async ({ path, database }) => {
    database.exec(
      "INSERT INTO campaign(campaign_id, objective, charter_json, lifecycle, accountable_primary, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ["codex-adapter-001", "Initial objective", "{}", "DRAFT", "owner", 1, "2026-08-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z"],
    );
    database.exec("UPDATE campaign SET objective = :objective WHERE campaign_id = :campaign", {
      objective: "Bound objective",
      campaign: "codex-adapter-001",
    });
    assert.deepEqual(database.query("SELECT objective FROM campaign WHERE campaign_id = ?", ["codex-adapter-001"]), [{ objective: "Bound objective" }]);

    database.transaction((connection) => {
      connection.exec("UPDATE campaign SET lifecycle = ? WHERE campaign_id = ?", ["READY", "codex-adapter-001"]);
    });
    assert.equal(database.query("SELECT lifecycle FROM campaign WHERE campaign_id = ?", ["codex-adapter-001"])[0].lifecycle, "READY");

    assert.throws(() => database.transaction((connection) => {
      connection.exec("UPDATE campaign SET lifecycle = ? WHERE campaign_id = ?", ["EXECUTING", "codex-adapter-001"]);
      throw new Error("rollback adapter transaction");
    }), /rollback adapter transaction/);
    assert.equal(database.query("SELECT lifecycle FROM campaign WHERE campaign_id = ?", ["codex-adapter-001"])[0].lifecycle, "READY");

    database.exec(
      "UPDATE campaign SET objective = $objective WHERE campaign_id = $campaign AND 'literal :objective' = 'literal :objective' /* @objective :campaign */ -- :campaign\n",
      { objective: "Dollar objective", campaign: "codex-adapter-001" },
    );
    assert.equal(database.query("SELECT objective FROM campaign WHERE campaign_id = ?", ["codex-adapter-001"])[0].objective, "Dollar objective");
    database.exec(
      "UPDATE campaign SET objective = @objective WHERE campaign_id = @campaign AND 'literal $objective' = 'literal $objective' /* :objective $campaign */ -- :campaign\n",
      { objective: "At objective", campaign: "codex-adapter-001" },
    );
    assert.equal(database.query("SELECT objective FROM campaign WHERE campaign_id = ?", ["codex-adapter-001"])[0].objective, "At objective");

    database.transaction((outer) => {
      outer.exec("UPDATE campaign SET lifecycle = ? WHERE campaign_id = ?", ["EXECUTING", "codex-adapter-001"]);
      assert.throws(() => outer.transaction((inner) => {
        inner.exec("UPDATE campaign SET objective = ? WHERE campaign_id = ?", ["inner rollback", "codex-adapter-001"]);
        throw new Error("inner rollback");
      }), /inner rollback/);
      outer.exec("UPDATE campaign SET objective = ? WHERE campaign_id = ?", ["outer work", "codex-adapter-001"]);
    });
    assert.deepEqual(database.query("SELECT objective, lifecycle FROM campaign WHERE campaign_id = ?", ["codex-adapter-001"]), [{ objective: "outer work", lifecycle: "EXECUTING" }]);

    assert.throws(() => database.transaction((outer) => {
      outer.transaction((inner) => {
        inner.exec("UPDATE campaign SET objective = ? WHERE campaign_id = ?", ["inner commit", "codex-adapter-001"]);
      });
      throw new Error("outer rollback");
    }), /outer rollback/);
    assert.equal(database.query("SELECT objective FROM campaign WHERE campaign_id = ?", ["codex-adapter-001"])[0].objective, "outer work");
    assert.throws(() => database.transaction(() => Promise.resolve("async")), (error) => error instanceof CampaignSqliteError && error.code === "CAMPAIGN_SQLITE_ASYNC_TRANSACTION");

    for (const sidecar of [path, `${path}-wal`, `${path}-shm`]) {
      assert.equal(existsSync(sidecar), true);
      if (process.platform === "win32") {
        // Node's POSIX mode projection does not verify Windows ACLs.
        assert.equal(statSync(sidecar).isFile(), true);
      } else {
        assert.equal(statSync(sidecar).mode & 0o077, 0);
      }
    }

    database.close();
    database.close();
    assert.throws(() => database.query("SELECT 1"), (error) => error instanceof CampaignSqliteError && error.code === "CAMPAIGN_DATABASE_CLOSED");
  });
});

test("schema adapter validation fails closed for missing OMO tables and checksum drift", async () => {
  await withSqlite(async ({ directory, database }) => {
    const missingTablePath = join(directory, "missing", "campaigns.sqlite3");
    const missingTable = openSqlite({ path: missingTablePath, allowCreate: true });
    missingTable.exec("DROP TABLE event");
    missingTable.close();
    assert.throws(() => openSqlite({ path: missingTablePath }), /SCHEMA_TABLE_MISSING/);

    const checksumPath = join(directory, "checksum", "campaigns.sqlite3");
    const checksum = openSqlite({ path: checksumPath, allowCreate: true });
    checksum.exec("UPDATE schema_migration SET checksum = ? WHERE version = ?", ["wrong", 1]);
    checksum.close();
    assert.throws(() => openSqlite({ path: checksumPath }), /SCHEMA_CHECKSUM_MISMATCH/);

    // Keep the callback's fixture open long enough to exercise deterministic cleanup.
    assert.ok(database.validateSchema().tables.includes("event"));
  });
});

test("state adapter rejects relative paths, missing migration ledgers, and newer schema versions", async () => {
  assert.throws(() => openSqlite({ path: "relative-campaigns.sqlite3" }), (error) => error instanceof CampaignSqliteError && error.code === "CAMPAIGN_DATABASE_PATH_ABSOLUTE");
  await withSqlite(async ({ directory }) => {
    const missingMigrationPath = join(directory, "missing-migration", "campaigns.sqlite3");
    const missingMigration = openSqlite({ path: missingMigrationPath, allowCreate: true });
    missingMigration.exec("DROP TABLE schema_migration");
    missingMigration.close();
    assert.throws(() => openSqlite({ path: missingMigrationPath }), /SCHEMA_TABLE_MISSING/);

    const newerPath = join(directory, "newer", "campaigns.sqlite3");
    const newer = openSqlite({ path: newerPath, allowCreate: true });
    newer.exec("UPDATE schema_migration SET version = ? WHERE version = ?", [2, 1]);
    newer.close();
    assert.throws(() => openSqlite({ path: newerPath }), /SCHEMA_VERSION_UNSUPPORTED/);
  });
});

test("OMO campaign create/list/detail and deterministic identity digest", async () => {
  await withStore(async ({ scope, store }) => {
    const base = contract(scope);
    const created = store.create(base);
    assert.equal(created.lifecycle, "DRAFT");
    assert.equal(created.version, 1);
    assert.match(created.identity_digest, /^[a-f0-9]{64}$/);
    assert.deepEqual(store.list().campaigns.map(({ campaign_id }) => campaign_id), [base.campaign_id]);
    const detail = store.detail(base.campaign_id);
    assert.equal(detail.identity_digest, store.identityDigest(base.campaign_id));
    assert.equal(detail.durable_event_count, 1);
    assert.ok(detail.scope_roots.includes(scope));
    assert.equal(store.db.query("SELECT COUNT(*) AS count FROM campaign")[0].count, 1);
    assert.equal(store.db.query("SELECT COUNT(*) AS count FROM event")[0].count, 1);
  });
});

test("campaign work packages reject sibling paths outside campaign scope", async () => {
  await withStore(async ({ directory, scope, store }) => {
    const base = contract(scope);
    store.create(base);
    store.bind({
      campaign_id: base.campaign_id,
      expected_version: 1,
      identity_digest: store.identityDigest(base.campaign_id),
      actor: "owner",
      run_id: "run-owner",
      thread_id: "thread-owner",
    });

    assert.throws(
      () => store.workPackage({
        campaign_id: base.campaign_id,
        expected_version: 1,
        actor: "owner",
        run_id: "run-owner",
        work_package_id: "wp-outside-scope",
        title: "Reject sibling path",
        task: { objective: "Allowed paths stay inside campaign scope" },
        allowed_paths: [join(directory, "scope-sibling")],
      }),
      (error) => error instanceof CampaignError && error.code === "SCOPE_VIOLATION" && error.details.mutated === false,
    );
    assert.equal(store.detail(base.campaign_id).version, 1);
  });
});

test("non-default campaign profiles round-trip through the OMO opening charter", async () => {
  await withStore(async ({ scope, store }) => {
    const base = {
      ...contract(scope),
      campaign_id: "campaign-engineering-profile",
      profile: "engineering",
    };
    const created = store.create(base);
    assert.equal(created.profile, "engineering");
    assert.equal(created.charter.profile, "engineering");
    assert.equal(store.detail(base.campaign_id).profile, "engineering");
    const opening = JSON.parse(store.db.query("SELECT payload_json FROM event WHERE campaign_id = ?", [base.campaign_id])[0].payload_json);
    assert.equal(opening.charter.profile, "engineering");
    const resumed = store.open({ ...base, mode: "resume_exact" });
    assert.equal(resumed.profile, "engineering");
  });
});

test("campaign IDs use the OMO 1-128 character alphanumeric-hyphen-underscore contract", async () => {
  await withStore(async ({ scope, store }) => {
    const oneCharacter = store.create({ ...contract(scope), campaign_id: "A" });
    assert.equal(oneCharacter.campaign_id, "A");
    for (const campaignId of [" A", "A ", "\tA", "bad.id", "bad:id", `a${"x".repeat(128)}`]) {
      assert.throws(
        () => store.create({ ...contract(scope), campaign_id: campaignId }),
        (error) => error instanceof CampaignError && error.code === "INVALID_INPUT" && error.details.mutated === false,
      );
    }
    assert.throws(
      () => store.detail(" A "),
      (error) => error instanceof CampaignError && error.code === "INVALID_INPUT" && error.details.mutated === false,
    );
    assert.equal(store.db.query("SELECT COUNT(*) AS count FROM campaign")[0].count, 1);
  });
});

test("omitted charter uses the OMO opening default and supports exact resume/bind", async () => {
  await withStore(async ({ scope, store }) => {
    const base = {
      campaign_id: "campaign-omo-default-charter",
      objective: "Use the OMO default opening charter",
      scope_roots: [scope],
      actor: "owner",
    };
    const created = store.create(base);
    const expectedCharter = { objective: base.objective, scope_roots: [scope] };
    assert.deepEqual(created.charter, expectedCharter);
    assert.deepEqual(store.db.query("SELECT payload_json FROM event WHERE campaign_id = ?", [base.campaign_id]).map(({ payload_json }) => JSON.parse(payload_json)["charter"]), [expectedCharter]);
    assert.deepEqual(store.list().campaigns[0].scope_roots, [scope]);
    const resumed = store.open({ ...base, mode: "resume_exact" });
    assert.equal(resumed.identity_digest, created.identity_digest);
    const bound = store.bind({
      campaign_id: base.campaign_id,
      expected_version: 1,
      identity_digest: created.identity_digest,
      actor: "owner",
      run_id: "run-omo-default-charter",
      thread_id: "thread-omo-default-charter",
    });
    assert.equal(bound.version, 1);
    assert.throws(
      () => store.create({ ...base, campaign_id: "campaign-explicit-null-charter", charter: null }),
      (error) => error instanceof CampaignError && error.code === "INVALID_INPUT" && error.details.mutated === false,
    );
  });
});

test("scope-root ordering is canonicalized for exact resume and binding", async () => {
  await withStore(async ({ directory, scope, store }) => {
    const secondScope = join(directory, "scope-b");
    await mkdir(secondScope);
    const base = {
      campaign_id: "campaign-canonical-roots",
      objective: "Canonicalize scope roots",
      scope_roots: [secondScope, scope],
      actor: "owner",
      charter: { protected_state: ["raw-sources"] },
    };
    const created = store.create(base);
    const canonicalRoots = [...base.scope_roots].sort();
    assert.deepEqual(created.scope_roots, canonicalRoots);
    const reordered = { ...base, scope_roots: [...canonicalRoots].reverse() };
    const resumed = store.open({ ...reordered, mode: "resume_exact" });
    assert.equal(resumed.identity_digest, created.identity_digest);
    const bound = store.bind({
      campaign_id: base.campaign_id,
      expected_version: 1,
      identity_digest: created.identity_digest,
      actor: "owner",
      run_id: "run-canonical-roots",
      thread_id: "thread-canonical-roots",
    });
    assert.equal(bound.version, 1);
  });
});

test("exact resume rejects objective, scope, charter, and accountable-owner drift without mutation", async () => {
  await withStore(async ({ scope, store }) => {
    const base = contract(scope);
    store.create(base);
    const before = store.db.query("SELECT campaign_id, version, objective, charter_json FROM campaign")[0];
    const beforeEvents = store.db.query("SELECT event_id, previous_version, new_version, payload_json FROM event");
    for (const changed of [
      { objective: "different objective" },
      { scope_roots: [join(scope, "other")] },
      { charter: { protected_state: ["changed"] } },
      { accountable_primary: "different-owner" },
    ]) {
      assert.throws(
        () => store.open({ ...base, ...changed, mode: "resume_exact" }),
        (error) => error instanceof CampaignError && error.code === "CAMPAIGN_IDENTITY_MISMATCH" && error.details.mutated === false,
      );
      assert.deepEqual(store.db.query("SELECT campaign_id, version, objective, charter_json FROM campaign")[0], before);
      assert.deepEqual(store.db.query("SELECT event_id, previous_version, new_version, payload_json FROM event"), beforeEvents);
    }
  });
});

test("opening identity remains stable across phase metadata updates and exact resume", async () => {
  await withStore(async ({ scope, store }) => {
    const base = contract(scope);
    store.create(base);
    const openingDigest = store.identityDigest(base.campaign_id);
    const updated = store.update({
      campaign_id: base.campaign_id,
      expected_version: 1,
      actor: "owner",
      phase: "METHOD_REVIEW",
    });
    assert.equal(updated.phase.phase_id, "METHOD_REVIEW");
    assert.deepEqual(Object.keys(updated.phase).sort(), ["authority_basis", "checkpoint", "hard_stops", "next_gate", "phase_id"]);
    const phaseEvent = store.db.query("SELECT payload_json FROM event WHERE campaign_id = ? ORDER BY new_version DESC LIMIT 1", [base.campaign_id])[0];
    const phasePayload = JSON.parse(phaseEvent.payload_json);
    assert.deepEqual(Object.keys(phasePayload).sort(), ["phase", "update_type"]);
    assert.deepEqual(Object.keys(phasePayload.phase).sort(), ["authority_basis", "checkpoint", "hard_stops", "next_gate", "phase_id"]);
    assert.equal(updated.identity_digest, openingDigest);
    assert.equal(store.detail(base.campaign_id).identity_digest, openingDigest);
    assert.deepEqual(store.detail(base.campaign_id).charter, base.charter);

    const resumed = store.open({ ...base, mode: "resume_exact" });
    assert.equal(resumed.identity_digest, openingDigest);
    assert.equal(resumed.phase.phase_id, "METHOD_REVIEW");

    const beforeEvents = store.db.query("SELECT * FROM event WHERE campaign_id = ?", [base.campaign_id]);
    const bound = store.bind({
      campaign_id: base.campaign_id,
      expected_version: updated.version,
      identity_digest: openingDigest,
      actor: "owner",
      run_id: "run-after-phase",
      thread_id: "thread-after-phase",
    });
    assert.equal(bound.version, updated.version);
    assert.deepEqual(store.db.query("SELECT * FROM event WHERE campaign_id = ?", [base.campaign_id]), beforeEvents);
  });
});

test("campaigns without a valid immutable opening event fail closed", async () => {
  await withSqlite(async ({ directory, database }) => {
    const campaignId = "campaign-without-opening";
    const timestamp = "2026-08-01T00:00:00.000Z";
    database.exec(
      "INSERT INTO campaign(campaign_id, objective, charter_json, lifecycle, accountable_primary, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [campaignId, "Mutable objective", "{}", "DRAFT", "owner", 1, timestamp, timestamp],
    );
    database.exec(
      "INSERT INTO scope_root(scope_root_id, campaign_id, path, attribution_class, created_at) VALUES (?, ?, ?, ?, ?)",
      [`${campaignId}:scope:1`, campaignId, directory, "PRIMARY_DIRECT", timestamp],
    );
    const store = createStore({ dbPath: join(directory, "state", "campaigns.sqlite3") });
    try {
      assert.throws(
        () => store.detail(campaignId),
        (error) => error instanceof CampaignError && error.code === "STATE_INTEGRITY_ERROR" && error.details.mutated === false,
      );
    } finally {
      store.dispose();
    }
  });
});

test("event-chain and materialized-row corruption fail closed before mutation", async () => {
  await withStore(async ({ scope, store }) => {
    const base = contract(scope);
    store.create(base);
    const changedAt = "2026-08-02T00:00:00.000Z";
    store.db.exec(
      "INSERT INTO event(event_id, campaign_id, event_type, actor, timestamp, previous_version, new_version, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [`${base.campaign_id}:gap`, base.campaign_id, "campaign_update", "owner", changedAt, 2, 3, JSON.stringify({ update_type: "lifecycle_transition", lifecycle: "ORIENTING" })],
    );
    const beforeEvents = store.db.query("SELECT * FROM event WHERE campaign_id = ?", [base.campaign_id]);
    assert.throws(
      () => store.update({ campaign_id: base.campaign_id, expected_version: 1, actor: "owner", lifecycle: "ORIENTING" }),
      (error) => error instanceof CampaignError && error.code === "STATE_INTEGRITY_ERROR" && error.details.mutated === false,
    );
    assert.deepEqual(store.db.query("SELECT * FROM event WHERE campaign_id = ?", [base.campaign_id]), beforeEvents);
  });

  await withStore(async ({ scope, store }) => {
    const base = contract(scope);
    store.create(base);
    store.db.exec("UPDATE campaign SET lifecycle = ? WHERE campaign_id = ?", ["READY", base.campaign_id]);
    const beforeEvents = store.db.query("SELECT * FROM event WHERE campaign_id = ?", [base.campaign_id]);
    assert.throws(
      () => store.detail(base.campaign_id),
      (error) => error instanceof CampaignError && error.code === "STATE_INTEGRITY_ERROR" && error.details.mutated === false,
    );
    assert.deepEqual(store.db.query("SELECT * FROM event WHERE campaign_id = ?", [base.campaign_id]), beforeEvents);
  });
});

test("malformed durable phase transitions fail strict OMO integrity replay", async () => {
  await withStore(async ({ scope, store }) => {
    const base = { ...contract(scope), campaign_id: "campaign-malformed-phase" };
    store.create(base);
    const malformedPhase = {
      phase_id: "METHOD_REVIEW",
      next_gate: "owner-review",
      hard_stops: ["owner approval required"],
      authority_basis: "owner charter",
    };
    const changedAt = "2026-08-02T00:00:00.000Z";
    store.db.exec(
      "INSERT INTO event(event_id, campaign_id, event_type, actor, timestamp, previous_version, new_version, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [`${base.campaign_id}:malformed-phase`, base.campaign_id, "campaign_update", "owner", changedAt, 1, 2, JSON.stringify({ update_type: "phase_transition", phase: malformedPhase })],
    );
    store.db.exec(
      "UPDATE campaign SET charter_json = ?, version = ?, updated_at = ? WHERE campaign_id = ?",
      [JSON.stringify({ ...base.charter, current_phase: malformedPhase }), 2, changedAt, base.campaign_id],
    );
    const beforeEvents = store.db.query("SELECT * FROM event WHERE campaign_id = ?", [base.campaign_id]);
    assert.throws(
      () => store.detail(base.campaign_id),
      (error) => error instanceof CampaignError
        && error.code === "STATE_INTEGRITY_ERROR"
        && error.details.reason === "phase_transition_event_invalid"
        && error.details.mutated === false,
    );
    assert.deepEqual(store.db.query("SELECT * FROM event WHERE campaign_id = ?", [base.campaign_id]), beforeEvents);
  });
});

test("malformed immutable opening fields fail closed with structured state errors", async () => {
  await withSqlite(async ({ directory, database }) => {
    const timestamp = "2026-08-01T00:00:00.000Z";
    const validPayload = {
      objective: "Immutable objective",
      scope_roots: [directory],
      charter: {},
      accountable_primary: "owner",
    };
    const cases = [
      ["charter-null", { payload: { ...validPayload, charter: null } }],
      ["charter-missing", { payload: Object.fromEntries(Object.entries(validPayload).filter(([key]) => key !== "charter")) }],
      ["accountable-null", { payload: { ...validPayload, accountable_primary: null } }],
      ["accountable-missing", { payload: Object.fromEntries(Object.entries(validPayload).filter(([key]) => key !== "accountable_primary")) }],
      ["actor-empty", { actor: "" }],
      ["timestamp-invalid", { eventTimestamp: "not-an-iso-timestamp" }],
    ];
    for (const [suffix, options] of cases) {
      const campaignId = `campaign-malformed-${suffix}`;
      database.exec(
        "INSERT INTO campaign(campaign_id, objective, charter_json, lifecycle, accountable_primary, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [campaignId, validPayload.objective, "{}", "DRAFT", "owner", 1, timestamp, timestamp],
      );
      database.exec(
        "INSERT INTO scope_root(scope_root_id, campaign_id, path, attribution_class, created_at) VALUES (?, ?, ?, ?, ?)",
        [`${campaignId}:scope:1`, campaignId, directory, "PRIMARY_DIRECT", timestamp],
      );
      database.exec(
        "INSERT INTO event(event_id, campaign_id, event_type, actor, timestamp, previous_version, new_version, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [`${campaignId}:open`, campaignId, "campaign_open", options.actor ?? "owner", options.eventTimestamp ?? timestamp, 0, 1, JSON.stringify(options.payload ?? validPayload)],
      );
    }
    const store = createStore({ dbPath: join(directory, "state", "campaigns.sqlite3") });
    try {
      for (const [suffix] of cases) {
        assert.throws(
          () => store.detail(`campaign-malformed-${suffix}`),
          (error) => error instanceof CampaignError && error.code === "STATE_INTEGRITY_ERROR" && error.details.mutated === false,
        );
      }
    } finally {
      store.dispose();
    }
  });
});

test("bind verifies digest/version but does not mutate the campaign version or event history", async () => {
  await withStore(async ({ scope, store }) => {
    const base = contract(scope);
    store.create(base);
    const digest = store.identityDigest(base.campaign_id);
    const beforeEvents = store.db.query("SELECT * FROM event");
    const bound = store.bind({ campaign_id: base.campaign_id, expected_version: 1, identity_digest: digest, actor: "owner", run_id: "run-owner", thread_id: "thread-owner" });
    assert.equal(bound.version, 1);
    assert.equal(bound.bound_run.run_id, "run-owner");
    assert.deepEqual(store.db.query("SELECT * FROM event"), beforeEvents);
    assert.equal(store.db.query("SELECT version FROM campaign WHERE campaign_id = ?", [base.campaign_id])[0].version, 1);
    assert.throws(
      () => store.bind({ campaign_id: base.campaign_id, expected_version: 0, identity_digest: digest, actor: "owner", run_id: "run-stale", thread_id: "thread-stale" }),
      (error) => error instanceof CampaignError && error.code === "CAMPAIGN_VERSION_CONFLICT" && error.details.mutated === false,
    );
  });
});

test("OMO work packages, receipts, reconcile, preflight, and terminal finish preserve evidence", async () => {
  await withStore(async ({ scope, store }) => {
    const base = contract(scope);
    store.create(base);
    store.bind({ campaign_id: base.campaign_id, expected_version: 1, identity_digest: store.identityDigest(base.campaign_id), actor: "owner", run_id: "run-owner", thread_id: "thread-owner" });
    const oriented = store.update({ campaign_id: base.campaign_id, expected_version: 1, actor: "owner", lifecycle: "ORIENTING", details: { reason: "preflight" } });
    assert.equal(oriented.version, 2);
    const packageState = store.workPackage({ campaign_id: base.campaign_id, expected_version: oriented.version, actor: "owner", run_id: "run-owner", work_package_id: "wp-method", title: "Check method", task: { objective: "Review the method" }, allowed_paths: [scope], required_governance: ["co-researcher:research-methodology"], required_verification: ["parent-review"], stop_conditions: ["scope mismatch"] });
    assert.equal(packageState.work_packages.find((item) => item.work_package_id === "wp-method").status, "DRAFT");
    const persistedPackage = JSON.parse(store.db.query("SELECT contract_json FROM work_package WHERE package_id = ?", ["wp-method"])[0].contract_json);
    assert.deepEqual(Object.keys(persistedPackage).sort(), ["allowed_paths", "authority_and_freshness_slice", "campaign_id", "command_policy", "dependencies", "expected_outputs", "forbidden_actions", "objective", "package_id", "receipt_schema_version", "required_inputs", "scope_roots", "status", "stop_conditions", "verification_checks"].sort());
    assert.equal(persistedPackage.authority_and_freshness_slice.snapshot_id, `${base.campaign_id}:snapshot:current`);
    assert.equal(persistedPackage.command_policy.allow_raw_command_retention, false);
    const packageStatusState = store.update({ campaign_id: base.campaign_id, expected_version: packageState.version, actor: "owner", work_package_id: "wp-method", work_package_status: "READY" });
    const statusEvent = store.db.query("SELECT payload_json FROM event WHERE campaign_id = ? ORDER BY new_version DESC LIMIT 1", [base.campaign_id])[0];
    const statusPayload = JSON.parse(statusEvent.payload_json);
    assert.deepEqual(Object.keys(statusPayload).sort(), ["package_id", "status", "update_type"].sort());
    assert.deepEqual(statusPayload, { update_type: "work_package_status", package_id: "wp-method", status: "READY" });
    const receipt = store.receipt({ campaign_id: base.campaign_id, expected_version: packageStatusState.version, actor: "owner", run_id: "run-owner", work_package_id: "wp-method", kind: "method", data: { summary: "Read the project state document", files_read: ["docs/project-state.md"] } });
    const persistedReceipt = JSON.parse(store.db.query("SELECT receipt_json FROM receipt ORDER BY created_at DESC LIMIT 1")[0].receipt_json);
    assert.deepEqual(Object.keys(persistedReceipt).sort(), ["artifacts", "blockers", "campaign_id", "commands", "continuation_token", "decisions_proposed", "files_created", "files_deleted", "files_modified", "files_read", "governance_conflicts", "package_id", "receipt_id", "schema_version", "status", "summary", "verification"].sort());
    assert.equal(persistedReceipt.package_id, "wp-method");
    const reconciled = store.reconcile({ campaign_id: base.campaign_id, expected_version: receipt.version, actor: "owner", run_id: "run-owner", work_package_id: "wp-method", outcome: "accepted", details: { reviewer: "owner" } });
    assert.equal(reconciled.work_packages.find((item) => item.work_package_id === "wp-method").status, "ACCEPTED");
    const preflight = store.preflight({ campaign_id: base.campaign_id, run_id: "run-owner" });
    assert.equal(preflight.phase_is_not_identity, true);
    assert.ok(preflight.profile_requirements.required_skills.includes("co-researcher:research-manager"));
    const executing = store.update({ campaign_id: base.campaign_id, expected_version: reconciled.version, actor: "owner", lifecycle: "EXECUTING" });
    const methodPhase = store.update({ campaign_id: base.campaign_id, expected_version: executing.version, actor: "owner", phase: "METHOD_REVIEW" });
    const verifying = store.update({ campaign_id: base.campaign_id, expected_version: methodPhase.version, actor: "owner", lifecycle: "VERIFYING" });
    const finalPhase = store.update({ campaign_id: base.campaign_id, expected_version: verifying.version, actor: "owner", phase: "FINAL_REVIEW" });
    assert.throws(
      () => store.finish({ campaign_id: base.campaign_id, expected_version: finalPhase.version, actor: "owner", run_id: "run-owner", closeout: { final_inventory: ["wp-method"] } }),
      (error) => error instanceof CampaignError && error.code === "INVALID_TRANSITION" && error.details.mutated === false,
    );
    const closing = store.update({ campaign_id: base.campaign_id, expected_version: finalPhase.version, actor: "owner", lifecycle: "CLOSING" });
    const finished = store.finish({ campaign_id: base.campaign_id, expected_version: closing.version, actor: "owner", run_id: "run-owner", closeout: { final_inventory: ["wp-method", "method receipt"], unresolved: [], limitations: [] } });
    assert.equal(finished.lifecycle, "CLOSED");
    assert.equal(finished.work_packages.find((item) => item.work_package_id === "wp-method").status, "ACCEPTED");
    assert.ok(finished.artifacts.some((item) => item.identity === `campaign-closeout:${base.campaign_id}`));
    assert.equal(store.db.query("SELECT COUNT(*) AS count FROM receipt WHERE campaign_id = ? AND package_id IS NULL", [base.campaign_id])[0].count, 0);
    const closeEvent = store.db.query("SELECT event_type, payload_json FROM event WHERE campaign_id = ? ORDER BY new_version DESC LIMIT 1", [base.campaign_id])[0];
    assert.equal(closeEvent.event_type, "campaign_close");
    assert.deepEqual(JSON.parse(closeEvent.payload_json), { closure_kind: "FULL", limitations: [] });
    const events = store.db.query("SELECT previous_version, new_version FROM event WHERE campaign_id = ? ORDER BY new_version", [base.campaign_id]);
    assert.deepEqual(events.map(({ previous_version, new_version }) => [previous_version, new_version]), events.map((_, index) => [index, index + 1]));
    assert.throws(() => store.db.exec("UPDATE event SET actor = ? WHERE campaign_id = ?", ["tampered", base.campaign_id]), /EVENT_IMMUTABLE/);
  });
});

test("direct ACCEPTED status cannot bypass a completed receipt and parent reconciliation", async () => {
  await withStore(async ({ scope, store }) => {
    const base = { ...contract(scope), campaign_id: "campaign-acceptance-gate" };
    store.create(base);
    store.bind({ campaign_id: base.campaign_id, expected_version: 1, identity_digest: store.identityDigest(base.campaign_id), actor: "owner", run_id: "run-owner", thread_id: "thread-owner" });
    const packageState = store.workPackage({ campaign_id: base.campaign_id, expected_version: 1, actor: "owner", run_id: "run-owner", work_package_id: "wp-evidence", title: "Require evidence", allowed_paths: [scope] });
    assert.throws(
      () => store.workPackage({ campaign_id: base.campaign_id, expected_version: packageState.version, actor: "owner", run_id: "run-owner", work_package_id: "wp-instant-terminal", title: "Cannot start accepted", status: "ACCEPTED", allowed_paths: [scope] }),
      (error) => error instanceof CampaignError && error.code === "WORK_PACKAGE_TERMINAL_STATUS_REQUIRES_RECONCILIATION" && error.details.mutated === false,
    );
    assert.throws(
      () => store.update({ campaign_id: base.campaign_id, expected_version: packageState.version, actor: "owner", work_package_id: "wp-evidence", work_package_status: "ACCEPTED" }),
      (error) => error instanceof CampaignError && error.code === "WORK_PACKAGE_ACCEPTANCE_REQUIRES_RECONCILIATION" && error.details.mutated === false,
    );
    const stillOpen = store.status(base.campaign_id);
    assert.equal(stillOpen.version, packageState.version);
    assert.equal(stillOpen.work_packages.find((item) => item.work_package_id === "wp-evidence").status, "DRAFT");
    assert.equal(stillOpen.durable_event_count, 2);

    assert.throws(
      () => store.receipt({ campaign_id: base.campaign_id, expected_version: packageState.version, actor: "worker", run_id: "run-owner", work_package_id: "wp-evidence", kind: "implementation", status: "COMPLETED", data: {} }),
      (error) => error instanceof CampaignError && error.code === "COMPLETED_RECEIPT_REQUIRES_EVIDENCE" && error.details.mutated === false,
    );
    const afterEmptyReceipt = store.status(base.campaign_id);
    assert.equal(afterEmptyReceipt.version, packageState.version);
    assert.equal(afterEmptyReceipt.durable_event_count, 2);

    const receipt = store.receipt({ campaign_id: base.campaign_id, expected_version: packageState.version, actor: "worker", run_id: "run-owner", work_package_id: "wp-evidence", kind: "implementation", status: "COMPLETED", data: { summary: "Changed the campaign report and verified output", files_modified: ["report.md"], verification: [{ artifact_id: "report", actor: "worker", outcome: "PASS", detail: "Output checked" }] } });
    const accepted = store.reconcile({ campaign_id: base.campaign_id, expected_version: receipt.version, actor: "owner", run_id: "run-owner", work_package_id: "wp-evidence", outcome: "accepted", details: { reviewer: "owner", evidence_receipt_id: receipt.receipts.at(-1).receipt_id } });
    assert.equal(accepted.work_packages.find((item) => item.work_package_id === "wp-evidence").status, "ACCEPTED");

    const reopened = store.update({ campaign_id: base.campaign_id, expected_version: accepted.version, actor: "owner", work_package_id: "wp-evidence", work_package_status: "READY" });
    assert.throws(
      () => store.reconcile({ campaign_id: base.campaign_id, expected_version: reopened.version, actor: "owner", run_id: "run-owner", work_package_id: "wp-evidence", outcome: "accepted", details: { reviewer: "owner" } }),
      (error) => error instanceof CampaignError && error.code === "ACCEPTANCE_REQUIRES_FRESH_COMPLETED_EVIDENCE" && error.details.mutated === false,
    );
    const newReceipt = store.receipt({ campaign_id: base.campaign_id, expected_version: reopened.version, actor: "worker", run_id: "run-owner", work_package_id: "wp-evidence", kind: "implementation", status: "COMPLETED", data: { summary: "Rechecked the reopened report change", files_modified: ["report.md"], verification: [{ artifact_id: "report", actor: "worker", outcome: "PASS", detail: "Rechecked after revision" }] } });
    const reaccepted = store.reconcile({ campaign_id: base.campaign_id, expected_version: newReceipt.version, actor: "owner", run_id: "run-owner", work_package_id: "wp-evidence", outcome: "accepted", details: { reviewer: "owner" } });
    assert.equal(reaccepted.work_packages.find((item) => item.work_package_id === "wp-evidence").status, "ACCEPTED");
  });
});

test("cancelled and superseded work packages require durable disposition reasons", async () => {
  await withStore(async ({ scope, store }) => {
    const base = { ...contract(scope), campaign_id: "campaign-package-disposition" };
    store.create(base);
    store.bind({ campaign_id: base.campaign_id, expected_version: 1, identity_digest: store.identityDigest(base.campaign_id), actor: "owner", run_id: "run-owner", thread_id: "thread-owner" });
    const first = store.workPackage({ campaign_id: base.campaign_id, expected_version: 1, actor: "owner", run_id: "run-owner", work_package_id: "wp-cancel", title: "Cancel with reason", allowed_paths: [scope] });
    assert.throws(
      () => store.update({ campaign_id: base.campaign_id, expected_version: first.version, actor: "owner", work_package_id: "wp-cancel", work_package_status: "CANCELLED" }),
      (error) => error instanceof CampaignError && error.code === "WORK_PACKAGE_DISPOSITION_REQUIRES_REASON" && error.details.mutated === false,
    );
    const cancelled = store.update({ campaign_id: base.campaign_id, expected_version: first.version, actor: "owner", work_package_id: "wp-cancel", work_package_status: "CANCELLED", details: { reason: "Owner removed this deliverable from scope" } });
    const event = store.db.query("SELECT payload_json FROM event WHERE campaign_id = ? ORDER BY new_version DESC LIMIT 1", [base.campaign_id])[0];
    assert.deepEqual(JSON.parse(event.payload_json), { update_type: "work_package_status", package_id: "wp-cancel", status: "CANCELLED", reason: "Owner removed this deliverable from scope" });
    assert.equal(cancelled.work_packages.find((item) => item.work_package_id === "wp-cancel").status, "CANCELLED");
  });
});

test("FULL closure blocks unresolved work; QUALIFIED closure records explicit limitations", async () => {
  await withStore(async ({ scope, store }) => {
    const base = { ...contract(scope), campaign_id: "campaign-full-close-gate" };
    store.create(base);
    store.bind({ campaign_id: base.campaign_id, expected_version: 1, identity_digest: store.identityDigest(base.campaign_id), actor: "owner", run_id: "run-owner", thread_id: "thread-owner" });
    let current = store.workPackage({ campaign_id: base.campaign_id, expected_version: 1, actor: "owner", run_id: "run-owner", work_package_id: "wp-one", title: "One", allowed_paths: [scope] });
    current = store.workPackage({ campaign_id: base.campaign_id, expected_version: current.version, actor: "owner", run_id: "run-owner", work_package_id: "wp-two", title: "Two", allowed_paths: [scope] });
    for (const lifecycle of ["ORIENTING", "READY", "EXECUTING", "VERIFYING", "CLOSING"]) current = store.update({ campaign_id: base.campaign_id, expected_version: current.version, actor: "owner", lifecycle });
    const before = store.status(base.campaign_id);
    assert.throws(
      () => store.finish({ campaign_id: base.campaign_id, expected_version: before.version, actor: "owner", run_id: "run-owner", closure_kind: "FULL", closeout: { final_inventory: ["wp-one", "wp-two"], limitations: [] } }),
      (error) => error instanceof CampaignError && error.code === "CAMPAIGN_WORK_PACKAGES_UNRESOLVED" && error.details.unresolved_work_packages.length === 2 && error.details.mutated === false,
    );
    const after = store.status(base.campaign_id);
    assert.equal(after.version, before.version);
    assert.equal(after.lifecycle, "CLOSING");
    assert.equal(after.durable_event_count, before.durable_event_count);
    assert.throws(
      () => store.finish({ campaign_id: base.campaign_id, expected_version: after.version, actor: "owner", run_id: "run-owner", closure_kind: "QUALIFIED", closeout: { final_inventory: ["wp-one", "wp-two"], limitations: [] } }),
      (error) => error instanceof CampaignError && error.code === "CAMPAIGN_LIMITATIONS_REQUIRED" && error.details.mutated === false,
    );
    const qualified = store.finish({ campaign_id: base.campaign_id, expected_version: after.version, actor: "owner", run_id: "run-owner", closure_kind: "QUALIFIED", closeout: { final_inventory: ["wp-one", "wp-two"], limitations: ["wp-one remains unresolved", "wp-two remains unresolved"] } });
    assert.equal(qualified.lifecycle, "CLOSED_QUALIFIED");
    const qualifiedLimitations = qualified.artifacts.find((item) => item.identity === `campaign-closeout:${base.campaign_id}`).metadata.limitations;
    assert.ok(qualifiedLimitations.some((limitation) => limitation.includes("wp-one")));
    assert.ok(qualifiedLimitations.some((limitation) => limitation.includes("wp-two")));
  });
});

test("QUALIFIED limitations must identify the complete package ID, not a prefix", async () => {
  await withStore(async ({ scope, store }) => {
    const base = { ...contract(scope), campaign_id: "campaign-qualified-id-boundary" };
    store.create(base);
    store.bind({ campaign_id: base.campaign_id, expected_version: 1, identity_digest: store.identityDigest(base.campaign_id), actor: "owner", run_id: "run-owner", thread_id: "thread-owner" });
    let current = store.workPackage({ campaign_id: base.campaign_id, expected_version: 1, actor: "owner", run_id: "run-owner", work_package_id: "wp-1", title: "Short identifier", allowed_paths: [scope] });
    current = store.workPackage({ campaign_id: base.campaign_id, expected_version: current.version, actor: "owner", run_id: "run-owner", work_package_id: "wp-10", title: "Longer identifier", allowed_paths: [scope] });
    for (const lifecycle of ["ORIENTING", "READY", "EXECUTING", "VERIFYING", "CLOSING"]) current = store.update({ campaign_id: base.campaign_id, expected_version: current.version, actor: "owner", lifecycle });
    assert.throws(
      () => store.finish({ campaign_id: base.campaign_id, expected_version: current.version, actor: "owner", run_id: "run-owner", closure_kind: "QUALIFIED", closeout: { final_inventory: ["wp-1", "wp-10"], limitations: ["wp-10 remains unresolved"] } }),
      (error) => error instanceof CampaignError && error.code === "CAMPAIGN_LIMITATIONS_REQUIRED" && error.details.limitations_required_for.includes("wp-1") && error.details.mutated === false,
    );
  });
});

test("a later partial receipt invalidates earlier completed acceptance evidence", async () => {
  await withStore(async ({ scope, store }) => {
    const base = { ...contract(scope), campaign_id: "campaign-latest-receipt-wins" };
    store.create(base);
    store.bind({ campaign_id: base.campaign_id, expected_version: 1, identity_digest: store.identityDigest(base.campaign_id), actor: "owner", run_id: "run-owner", thread_id: "thread-owner" });
    let current = store.workPackage({ campaign_id: base.campaign_id, expected_version: 1, actor: "owner", run_id: "run-owner", work_package_id: "wp-receipt-order", title: "Receipt ordering", allowed_paths: [scope] });
    const evidence = { summary: "Verified the output", files_modified: ["report.md"], verification: [{ artifact_id: "report", actor: "worker", outcome: "PASS", detail: "Output checked" }] };
    current = store.receipt({ campaign_id: base.campaign_id, expected_version: current.version, actor: "worker", run_id: "run-owner", work_package_id: "wp-receipt-order", kind: "implementation", status: "COMPLETED", data: evidence });
    current = store.reconcile({ campaign_id: base.campaign_id, expected_version: current.version, actor: "owner", run_id: "run-owner", work_package_id: "wp-receipt-order", outcome: "accepted", details: { reviewer: "owner" } });
    current = store.receipt({ campaign_id: base.campaign_id, expected_version: current.version, actor: "worker", run_id: "run-owner", work_package_id: "wp-receipt-order", kind: "implementation", status: "PARTIAL", data: { ...evidence, summary: "Follow-up work remains incomplete" } });
    for (const lifecycle of ["ORIENTING", "READY", "EXECUTING", "VERIFYING", "CLOSING"]) current = store.update({ campaign_id: base.campaign_id, expected_version: current.version, actor: "owner", lifecycle });
    assert.throws(
      () => store.finish({ campaign_id: base.campaign_id, expected_version: current.version, actor: "owner", run_id: "run-owner", closure_kind: "FULL", closeout: { final_inventory: ["wp-receipt-order"], limitations: [] } }),
      (error) => error instanceof CampaignError && error.code === "CAMPAIGN_WORK_PACKAGES_UNRESOLVED" && error.details.unresolved_work_packages.some((row) => row.package_id === "wp-receipt-order") && error.details.mutated === false,
    );
  });
});

test("malformed nested worker-receipt records never persist or advance the campaign", async () => {
  await withStore(async ({ scope, store }) => {
    const base = { ...contract(scope), campaign_id: "campaign-invalid-receipts" };
    store.create(base);
    store.bind({ campaign_id: base.campaign_id, expected_version: 1, identity_digest: store.identityDigest(base.campaign_id), actor: "owner", run_id: "run-owner", thread_id: "thread-owner" });
    const packageState = store.workPackage({ campaign_id: base.campaign_id, expected_version: 1, actor: "owner", run_id: "run-owner", work_package_id: "wp-receipts", title: "Validate receipts", allowed_paths: [scope] });
    const artifact = { artifact_id: "artifact-1", path: `${scope}/artifact.txt`, risk: "standard", creator: "worker" };
    const command = {
      command_hash: "sha256:0123456789abcdef",
      executable: "node",
      environment_fingerprint: "sha256:fedcba9876543210",
    };
    const verification = { artifact_id: "artifact-1", actor: "reviewer", outcome: "PASS", detail: "hash verified" };
    const missing = (value, key) => Object.fromEntries(Object.entries(value).filter(([entry]) => entry !== key));
    const invalidData = [
      ...["artifact_id", "path", "risk", "creator"].map((key) => ({ summary: "Worker reviewed an artifact", artifacts: [missing(artifact, key)] })),
      { summary: "Worker reviewed an artifact", artifacts: [{ ...artifact, risk: "low" }] },
      { summary: "Worker reviewed an artifact", artifacts: [{ ...artifact, unexpected: "field" }] },
      ...["command_hash", "executable", "environment_fingerprint"].map((key) => ({ summary: "Worker ran a check", commands: [missing(command, key)] })),
      { summary: "Worker ran a check", commands: [{ ...command, command_hash: "not-a-sha256" }] },
      { summary: "Worker ran a check", commands: [{ ...command, environment_fingerprint: "sha256:ABCDEF0123456789" }] },
      { summary: "Worker ran a check", commands: [{ ...command, raw_command: "" }] },
      { summary: "Worker ran a check", commands: [{ ...command, unexpected: "field" }] },
      ...["artifact_id", "actor", "outcome", "detail"].map((key) => ({ summary: "Reviewer checked output", verification: [missing(verification, key)] })),
      { summary: "Reviewer checked output", verification: [{ ...verification, outcome: "SKIP" }] },
      { summary: "Reviewer checked output", verification: [{ ...verification, unexpected: "field" }] },
    ];
    const beforeEvents = store.db.query("SELECT * FROM event WHERE campaign_id = ?", [base.campaign_id]);
    for (const data of invalidData) {
      assert.throws(
        () => store.receipt({ campaign_id: base.campaign_id, expected_version: packageState.version, actor: "owner", run_id: "run-owner", work_package_id: "wp-receipts", kind: "test", data }),
        (error) => error instanceof CampaignError && error.code === "INVALID_INPUT" && error.details.mutated === false,
      );
      assert.equal(store.db.query("SELECT COUNT(*) AS count FROM receipt WHERE campaign_id = ?", [base.campaign_id])[0].count, 0);
      assert.equal(store.db.query("SELECT version FROM campaign WHERE campaign_id = ?", [base.campaign_id])[0].version, packageState.version);
      assert.deepEqual(store.db.query("SELECT * FROM event WHERE campaign_id = ?", [base.campaign_id]), beforeEvents);
    }
  });
});

test("strict nested OMO worker-receipt records persist unchanged", async () => {
  await withStore(async ({ scope, store }) => {
    const base = { ...contract(scope), campaign_id: "campaign-valid-receipt" };
    store.create(base);
    store.bind({ campaign_id: base.campaign_id, expected_version: 1, identity_digest: store.identityDigest(base.campaign_id), actor: "owner", run_id: "run-owner", thread_id: "thread-owner" });
    const packageState = store.workPackage({ campaign_id: base.campaign_id, expected_version: 1, actor: "owner", run_id: "run-owner", work_package_id: "wp-valid-receipt", title: "Persist receipt", allowed_paths: [scope] });
    const artifacts = [{ artifact_id: "artifact-1", path: `${scope}/artifact.txt`, risk: "high_risk", creator: "worker" }];
    const commands = [{ command_hash: "sha256:0123456789abcdef", executable: "node", environment_fingerprint: "sha256:fedcba9876543210", raw_command: "node --check artifact.mjs" }];
    const verification = [{ artifact_id: "artifact-1", actor: "reviewer", outcome: "PASS", detail: "hash verified" }];
    const result = store.receipt({
      campaign_id: base.campaign_id,
      expected_version: packageState.version,
      actor: "owner",
      run_id: "run-owner",
      work_package_id: "wp-valid-receipt",
      kind: "test",
      data: { summary: "Created a verified artifact and checked it", artifacts, commands, verification },
    });
    assert.equal(result.version, packageState.version + 1);
    const persisted = JSON.parse(store.db.query("SELECT receipt_json FROM receipt WHERE campaign_id = ?", [base.campaign_id])[0].receipt_json);
    assert.deepEqual(persisted.artifacts, artifacts);
    assert.deepEqual(persisted.commands, commands);
    assert.deepEqual(persisted.verification, verification);
  });
});

test("stale expected-version mutation leaves OMO rows and event history unchanged", async () => {
  await withStore(async ({ scope, store }) => {
    const base = contract(scope);
    store.create(base);
    const beforeCampaign = store.db.query("SELECT * FROM campaign WHERE campaign_id = ?", [base.campaign_id])[0];
    const beforeEvents = store.db.query("SELECT * FROM event WHERE campaign_id = ?", [base.campaign_id]);
    assert.throws(() => store.update({ campaign_id: base.campaign_id, expected_version: 0, actor: "owner", lifecycle: "ORIENTING" }), (error) => error instanceof CampaignError && error.code === "CAMPAIGN_VERSION_CONFLICT" && error.details.mutated === false);
    assert.deepEqual(store.db.query("SELECT * FROM campaign WHERE campaign_id = ?", [base.campaign_id])[0], beforeCampaign);
    assert.deepEqual(store.db.query("SELECT * FROM event WHERE campaign_id = ?", [base.campaign_id]), beforeEvents);
  });
});

test("abandon uses an OMO lifecycle update and durable artifact evidence", async () => {
  await withStore(async ({ scope, store }) => {
    const base = contract(scope);
    store.create(base);
    store.bind({ campaign_id: base.campaign_id, expected_version: 1, identity_digest: store.identityDigest(base.campaign_id), actor: "owner", run_id: "run-owner", thread_id: "thread-owner" });
    const abandoned = store.abandon({ campaign_id: base.campaign_id, expected_version: 1, actor: "owner", run_id: "run-owner", reason: "Owner stopped the campaign", details: { last_verified_checkpoint: "checkpoint-1" }, limitations: ["unfinished"] });
    assert.equal(abandoned.lifecycle, "ABORTED");
    assert.ok(abandoned.artifacts.some((item) => item.identity === `campaign-abandonment:${base.campaign_id}`));
    assert.equal(store.db.query("SELECT COUNT(*) AS count FROM receipt WHERE campaign_id = ? AND package_id IS NULL", [base.campaign_id])[0].count, 0);
    const abandonEvent = store.db.query("SELECT event_type, payload_json FROM event WHERE campaign_id = ? ORDER BY new_version DESC LIMIT 1", [base.campaign_id])[0];
    assert.equal(abandonEvent.event_type, "campaign_update");
    assert.deepEqual(JSON.parse(abandonEvent.payload_json), { update_type: "lifecycle_transition", lifecycle: "ABORTED" });
    assert.equal(abandoned.bound_run.run_id, "run-owner");
  });
});

test("production default path is canonical and fail-closed with no old fallback database", async () => {
  const oldStateHome = process.env.XDG_STATE_HOME;
  const oldCodexState = process.env.CODEX_RESEARCH_CAMPAIGN_STATE_DIR;
  const directory = await mkdtemp(join(tmpdir(), "codex-production-path-"));
  try {
    process.env.XDG_STATE_HOME = directory;
    delete process.env.CODEX_RESEARCH_CAMPAIGN_STATE_DIR;
    assert.throws(() => createStore(), (error) => error instanceof CampaignSqliteError && error.code === "CAMPAIGN_DATABASE_MISSING");
    assert.equal(existsSync(join(directory, "omo-research", "campaigns.sqlite3")), false);
    assert.equal(existsSync(join(directory, "research-campaign", "campaigns.sqlite3")), false);
  } finally {
    if (oldStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = oldStateHome;
    if (oldCodexState === undefined) delete process.env.CODEX_RESEARCH_CAMPAIGN_STATE_DIR;
    else process.env.CODEX_RESEARCH_CAMPAIGN_STATE_DIR = oldCodexState;
    await rm(directory, { recursive: true, force: true });
  }
});
