import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "..");

async function readJson(path) {
  return JSON.parse(await readFile(join(root, path), "utf8"));
}

test("plugin package has a valid manifest boundary", async () => {
  const manifest = await readJson(".codex-plugin/plugin.json");
  const packageManifest = await readJson("package.json");
  assert.equal(manifest.name, "agent-campaign-manager");
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.version, packageManifest.version);
  assert.equal(manifest.skills, "./skills/");
  assert.equal(manifest.mcpServers, "./.mcp.json");
  assert.equal("hooks" in manifest, false);
  assert.ok(Array.isArray(manifest.interface.defaultPrompt));
  assert.ok(manifest.interface.defaultPrompt.length <= 3);
});

test("MCP package points to the local server without host mutation", async () => {
  const mcp = await readJson(".mcp.example.json");
  const server = mcp.mcpServers["research-campaign"];
  assert.ok(server.command === "node" || /(?:^|[\\/])node(?:\.exe)?$/i.test(server.command));
  assert.deepEqual(server.args, ["packages/mcp-server/src/server.mjs"]);
  if (server.cwd) {
    await access(join(server.cwd, server.args[0]));
  }
  const skillNames = [
    "campaign-orchestrator",
    "campaign-discovery",
    "campaign-research-governance",
    "campaign-execution-governance",
    "campaign-finish",
  ];
  for (const skill of skillNames) {
    const contents = await readFile(join(root, "skills", skill, "SKILL.md"), "utf8");
    assert.match(contents, /^---/);
    assert.match(contents, /campaign_/);
  }
});

test("campaign core and tool contract carry no harness names", async () => {
  for (const path of ["packages/campaign-core/src/core.mjs", "packages/campaign-core/src/sqlite.mjs", "packages/mcp-server/src/tools.mjs"]) {
    // The legacy state-directory alias is the only accepted harness-named token.
    const contents = (await readFile(join(root, path), "utf8")).replaceAll("CODEX_RESEARCH_CAMPAIGN_STATE_DIR", "");
    assert.doesNotMatch(contents, /codex|claude|hermes/i, path);
  }
  for (const skill of ["campaign-orchestrator", "campaign-discovery", "campaign-finish", "campaign-resume"]) {
    assert.doesNotMatch(await readFile(join(root, "skills", skill, "SKILL.md"), "utf8"), /codex/i, skill);
  }
});
