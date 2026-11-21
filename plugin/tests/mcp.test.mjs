import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { openSqlite } from "../packages/campaign-core/src/sqlite.mjs";

const packageRoot = join(import.meta.dirname, "..");
const serverPath = join(packageRoot, "packages/mcp-server/src/server.mjs");

function startServer(stateDir, executable = serverPath) {
  const child = spawn(process.execPath, [executable], {
    cwd: packageRoot,
    env: { ...process.env, CODEX_RESEARCH_CAMPAIGN_STATE_DIR: stateDir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const queue = [];
  const waiters = [];
  lines.on("line", (line) => {
    if (!line.trim()) return;
    const value = JSON.parse(line);
    const waiter = waiters.shift();
    if (waiter) waiter(value);
    else queue.push(value);
  });
  const rpc = (method, params = {}) => new Promise((resolve) => {
    if (queue.length) return resolve(queue.shift());
    waiters.push(resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: Date.now() + Math.random(), method, params })}\n`);
  });
  return {
    child,
    rpc,
    close: async () => {
      lines.close();
      child.kill("SIGTERM");
    await new Promise((resolve, reject) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once("error", reject);
      child.once("exit", () => resolve());
    });
    },
  };
}

test("unexpected tool failures report uncertain outcomes even after a successful write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "campaign-unknown-outcome-"));
  const scope = join(directory, "scope");
  const stateDir = join(directory, "state");
  await mkdir(scope);
  const fixture = openSqlite({ path: join(stateDir, "campaigns.sqlite3"), allowCreate: true });
  fixture.close();
  const shimPath = join(directory, "tools-shim.mjs");
  const testServer = join(directory, "server.mjs");
  const originalTools = pathToFileURL(join(packageRoot, "packages/mcp-server/src/tools.mjs")).href;
  const originalCore = pathToFileURL(join(packageRoot, "packages/campaign-core/src/core.mjs")).href;
  await writeFile(shimPath, `import { invokeTool as realInvoke, TOOL_DEFINITIONS } from ${JSON.stringify(originalTools)};\nexport { TOOL_DEFINITIONS };\nexport function invokeTool(store, name, args, session) { if (name === 'campaign_search') throw new Error('TEST_SECRET_MARKER'); const result = realInvoke(store, name, args, session); if (name === 'campaign_update') throw new Error('TEST_SECRET_MARKER'); return result; }\n`);
  const serverSource = (await readFile(serverPath, "utf8"))
    .replace('"../../campaign-core/src/core.mjs"', JSON.stringify(originalCore))
    .replace('"./tools.mjs"', JSON.stringify(pathToFileURL(shimPath).href));
  await writeFile(testServer, serverSource);
  const server = startServer(stateDir, testServer);
  try {
    const check = (response) => {
      const result = response.result;
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent.code, "INTERNAL_ERROR");
      assert.equal(result.structuredContent.details.mutated, null);
      assert.match(result.structuredContent.details.next_action, /inspect/i);
      assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
      assert.equal(JSON.stringify(result).includes("TEST_SECRET_MARKER"), false);
    };
    check(await call(server, "campaign_search", { query: "none" }));
    const created = (await call(server, "campaign_create", { campaign_id: "fault-test", objective: "Test uncertain writes", scope_roots: [scope], actor: "owner" })).result.structuredContent;
    await call(server, "campaign_bind", { campaign_id: "fault-test", expected_version: 1, identity_digest: created.identity_digest, actor: "owner", run_id: "run-1", thread_id: "thread-1" });
    check(await call(server, "campaign_update", { expected_version: 1, actor: "owner", lifecycle: "ORIENTING" }));
    const status = (await call(server, "campaign_status")).result.structuredContent;
    assert.equal(status.version, 2);
    assert.equal(status.lifecycle, "ORIENTING");
    assert.equal(status.durable_event_count, 2);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function call(server, name, arguments_ = {}) {
  return server.rpc("tools/call", { name, arguments: arguments_ });
}

function errorPayload(response) {
  assert.equal(response.result.isError, true);
  return response.result.structuredContent;
}

test("MCP exposes the explicit outside/bound campaign contract", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-research-mcp-"));
  const scope = join(directory, "scope");
  await mkdir(scope);
  const stateDir = join(directory, "state");
  const fixture = openSqlite({ path: join(stateDir, "campaigns.sqlite3"), allowCreate: true });
  fixture.close();
  const server = startServer(stateDir);
  try {
    const init = await server.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
    const packageManifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    assert.equal(init.result.serverInfo.version, packageManifest.version);
    assert.match(init.result.instructions, /campaign_list/);
    assert.match(init.result.instructions, /campaign_bind/);
    assert.match(init.result.instructions, /campaign_finish/);

    const tools = await server.rpc("tools/list");
    const names = tools.result.tools.map((tool) => tool.name).sort();
    const publicToolsBeforeBinding = names.slice();
    assert.deepEqual(names, [
      "campaign_abandon",
      "campaign_bind",
      "campaign_create",
      "campaign_detail",
      "campaign_finish",
      "campaign_list",
      "campaign_preflight",
      "campaign_receipt",
      "campaign_reconcile",
      "campaign_search",
      "campaign_status",
      "campaign_unbind",
      "campaign_update",
      "campaign_work_package",
    ].sort());
    assert.equal(names.includes("campaign_open"), false);
    assert.equal(names.includes("campaign_close"), false);

    const unboundStatus = await call(server, "campaign_status");
    assert.equal(errorPayload(unboundStatus).code, "CAMPAIGN_NOT_BOUND");
    assert.equal(errorPayload(unboundStatus).details.mutated, false);

    const created = await call(server, "campaign_create", {
      campaign_id: "mcp-campaign",
      objective: "MCP identity test",
      scope_roots: [scope],
      actor: "owner",
    });
    assert.equal(created.result.structuredContent.campaign_id, "mcp-campaign");
    assert.equal(created.result.structuredContent.version, 1);

    const detail = await call(server, "campaign_detail", { campaign_id: "mcp-campaign" });
    assert.equal(detail.result.structuredContent.identity_digest.length, 64);

    const wrongDigest = await call(server, "campaign_bind", {
      campaign_id: "mcp-campaign",
      expected_version: 1,
      identity_digest: "0".repeat(64),
      actor: "owner",
      run_id: "mcp-wrong-run",
      thread_id: "mcp-thread",
    });
    assert.equal(errorPayload(wrongDigest).code, "CAMPAIGN_IDENTITY_MISMATCH");
    assert.equal(errorPayload(wrongDigest).details.mutated, false);

    const bound = await call(server, "campaign_bind", {
      campaign_id: "mcp-campaign",
      expected_version: 1,
      identity_digest: detail.result.structuredContent.identity_digest,
      actor: "owner",
      run_id: "mcp-run",
      thread_id: "mcp-thread",
    });
    assert.equal(bound.result.structuredContent.mode, "BOUND_ACTIVE");
    assert.ok(bound.result.structuredContent.binding_token);
    assert.equal(bound.result.structuredContent.version, 1);
    const boundList = await call(server, "campaign_list");
    assert.equal(boundList.result.structuredContent.mode, "BOUND_ACTIVE");
    const boundSearch = await call(server, "campaign_search", { query: "mcp-campaign" });
    assert.equal(boundSearch.result.structuredContent.mode, "BOUND_ACTIVE");
    const publicToolsAfterBinding = (await server.rpc("tools/list")).result.tools.map((tool) => tool.name).sort();
    assert.deepEqual(publicToolsAfterBinding, publicToolsBeforeBinding);

    const boundDetail = await call(server, "campaign_detail", { campaign_id: "mcp-campaign" });
    assert.equal(errorPayload(boundDetail).code, "CAMPAIGN_BOUND_USE_STATUS");

    const listedWhileBound = await call(server, "campaign_list");
    assert.equal(listedWhileBound.result.structuredContent.campaigns.length, 1);
    const searched = await call(server, "campaign_search", { query: "identity" });
    assert.equal(searched.result.structuredContent.campaigns[0].campaign_id, "mcp-campaign");

    const preflight = await call(server, "campaign_preflight");
    assert.equal(preflight.result.structuredContent.campaign_id, "mcp-campaign");
    assert.equal(preflight.result.structuredContent.bound_run.run_id, "mcp-run");

    const workPackage = await call(server, "campaign_work_package", {
      expected_version: 1,
      actor: "owner",
      run_id: "mcp-run",
      work_package_id: "mcp-package",
      title: "Validate worker receipt",
      allowed_paths: [scope],
    });
    assert.equal(workPackage.result.structuredContent.version, 2);

    const invalidReceipt = await call(server, "campaign_receipt", {
      expected_version: 2,
      actor: "owner",
      run_id: "mcp-run",
      work_package_id: "mcp-package",
      kind: "test",
      data: { summary: "Worker attempted an incomplete artifact receipt", artifacts: [{ artifact_id: "artifact-1", path: `${scope}/artifact.txt`, risk: "standard" }] },
    });
    assert.equal(errorPayload(invalidReceipt).code, "INVALID_INPUT");
    assert.equal(errorPayload(invalidReceipt).details.mutated, false);

    const afterInvalidReceipt = await call(server, "campaign_status");
    assert.equal(afterInvalidReceipt.result.structuredContent.version, 2);
    assert.equal(afterInvalidReceipt.result.structuredContent.durable_event_count, 2);

    const receipt = await call(server, "campaign_receipt", {
      expected_version: 2,
      actor: "owner",
      run_id: "mcp-run",
      work_package_id: "mcp-package",
      kind: "test",
      data: { summary: "Read and validated the bounded test target", files_read: ["tests/fixture.json"] },
    });
    assert.equal(receipt.result.structuredContent.version, 3);

    const reconciled = await call(server, "campaign_reconcile", {
      expected_version: 3,
      actor: "owner",
      run_id: "mcp-run",
      work_package_id: "mcp-package",
      outcome: "accepted",
      details: { review: "passed", evidence_summary: "Read fixture data and verified output", files_read: ["fixture.json"] },
    });
    assert.equal(reconciled.result.structuredContent.version, 4);

    let version = 4;
    for (const lifecycle of ["ORIENTING", "READY", "EXECUTING", "VERIFYING", "CLOSING"]) {
      const updated = await call(server, "campaign_update", { expected_version: version, actor: "owner", lifecycle });
      version += 1;
      assert.equal(updated.result.structuredContent.version, version);
      assert.equal(updated.result.structuredContent.lifecycle, lifecycle);
    }

    const finished = await call(server, "campaign_finish", {
      expected_version: version,
      actor: "owner",
      run_id: "mcp-run",
      closure_kind: "FULL",
      closeout: { final_inventory: ["mcp-package"], limitations: [] },
    });
    assert.equal(finished.result.structuredContent.lifecycle, "CLOSED");
    const terminalStatus = await call(server, "campaign_status");
    assert.equal(terminalStatus.result.structuredContent.mode, "BOUND_TERMINAL");
    const blockedWork = await call(server, "campaign_work_package", {
      expected_version: version + 1,
      actor: "owner",
      run_id: "mcp-run",
      work_package_id: "mcp-package-2",
      title: "must be blocked",
      allowed_paths: [scope],
    });
    assert.equal(errorPayload(blockedWork).code, "CAMPAIGN_TERMINAL");

    const unbound = await call(server, "campaign_unbind");
    assert.equal(unbound.result.structuredContent.mode, "UNBOUND");
    assert.equal(unbound.result.structuredContent.mutated, false);
    const publicToolsAfterUnbind = (await server.rpc("tools/list")).result.tools.map((tool) => tool.name).sort();
    assert.deepEqual(publicToolsAfterUnbind, publicToolsBeforeBinding);
    const afterUnbind = await call(server, "campaign_status");
    assert.equal(errorPayload(afterUnbind).code, "CAMPAIGN_NOT_BOUND");

    for (const retiredName of ["campaign_open", "campaign_resume", "campaign_close"]) {
      const retired = await call(server, retiredName, {});
      assert.equal(errorPayload(retired).code, "DEPRECATED_TOOL");
      assert.equal(errorPayload(retired).details.mutated, false);
    }
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("campaign_abandon preserves a terminal record and requires a fresh bind", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-research-abandon-"));
  const scope = join(directory, "scope");
  await mkdir(scope);
  const stateDir = join(directory, "state");
  const fixture = openSqlite({ path: join(stateDir, "campaigns.sqlite3"), allowCreate: true });
  fixture.close();
  const server = startServer(stateDir);
  try {
    const created = await call(server, "campaign_create", {
      campaign_id: "abandon-campaign",
      objective: "Abandon test",
      scope_roots: [scope],
      actor: "owner",
    });
    const detail = await call(server, "campaign_detail", { campaign_id: "abandon-campaign" });
    await call(server, "campaign_bind", {
      campaign_id: "abandon-campaign",
      expected_version: created.result.structuredContent.version,
      identity_digest: detail.result.structuredContent.identity_digest,
      actor: "owner",
      run_id: "abandon-run",
      thread_id: "abandon-thread",
    });
    const abandoned = await call(server, "campaign_abandon", {
      expected_version: 1,
      actor: "owner",
      run_id: "abandon-run",
      reason: "Owner stopped the experiment",
      limitations: ["No production run was authorized"],
    });
    assert.equal(abandoned.result.structuredContent.lifecycle, "ABORTED");
    assert.equal((await call(server, "campaign_status")).result.structuredContent.mode, "BOUND_TERMINAL");
    await call(server, "campaign_unbind");
    const freshStatus = await call(server, "campaign_status");
    assert.equal(errorPayload(freshStatus).code, "CAMPAIGN_NOT_BOUND");
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
