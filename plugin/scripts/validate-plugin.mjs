#!/usr/bin/env node

import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const readJson = async (path) => JSON.parse(await readFile(join(root, path), "utf8"));

const manifest = await readJson(".codex-plugin/plugin.json");
const packageManifest = await readJson("package.json");
assert.equal(manifest.name, "agent-campaign-manager");
assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
assert.equal(manifest.version, packageManifest.version, "plugin descriptor and npm package versions must match");
assert.equal(manifest.skills, "./skills/");
assert.equal(manifest.mcpServers, "./.mcp.json");
assert.ok(manifest.interface?.displayName);
assert.ok(manifest.interface?.shortDescription);
assert.ok(Array.isArray(manifest.interface?.defaultPrompt));
assert.ok(manifest.interface.defaultPrompt.length > 0 && manifest.interface.defaultPrompt.length <= 3);

const mcp = await readJson(".mcp.example.json");
const server = mcp.mcpServers?.["research-campaign"];
assert.ok(server, "research-campaign MCP entry is required");
assert.ok(server.command === "node" || /(?:^|[\\/])node(?:\.exe)?$/i.test(server.command));
assert.deepEqual(server.args, ["packages/mcp-server/src/server.mjs"]);
assert.equal(server.env.CAMPAIGN_HARNESS, 'codex');
assert.equal(server.env.CAMPAIGN_CONTEXT_HOOKS, '1');
const hooks = await readJson('hooks/hooks.json');
for (const event of ['SessionStart', 'PostToolUse', 'UserPromptSubmit']) {
  const groups = hooks.hooks[event];
  assert.equal(groups.length, 1);
  const handler = groups[0].hooks[0];
  assert.equal(handler.type, 'mcp_tool');
  assert.equal(handler.server, 'research-campaign');
  assert.equal(handler.tool, 'campaign_context_hook');
  assert.equal(handler.input.event, event);
}
assert.equal(hooks.hooks.SessionStart[0].matcher, '^compact$');
await access(join(root, 'packages/mcp-server/src/hook-context.mjs'));

for (const skillName of ["campaign-orchestrator", "campaign-discovery", "campaign-research-governance", "campaign-execution-governance", "campaign-finish"]) {
  const skillPath = join("skills", skillName, "SKILL.md");
  const contents = await readFile(join(root, skillPath), "utf8");
  assert.match(contents, /^---\r?\nname: /);
  assert.match(contents, /campaign_/);
}

console.log("Codex Campaign Manager manifest, MCP path, state root, and required skills passed.");
