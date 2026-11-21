#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import readline from "node:readline";
import { CampaignError, createStore } from "../../campaign-core/src/core.mjs";
import { invokeTool, TOOL_DEFINITIONS } from "./tools.mjs";

const SERVER_VERSION = "0.2.0";
const SERVER_NAME = "agent-campaign-manager";

// Harness profile. Each client's MCP definition names its harness; the core never does.
// CODEX_CAMPAIGN_CONTEXT_HOOKS=1 is the legacy spelling of CAMPAIGN_HARNESS=codex + CAMPAIGN_CONTEXT_HOOKS=1.
// Without context hooks the server keeps the default contract (Hermes supplies its own runtime identity).
function harnessProfile(env) {
  const legacyCodex = env.CODEX_CAMPAIGN_CONTEXT_HOOKS === '1';
  const hooks = legacyCodex || env.CAMPAIGN_CONTEXT_HOOKS === '1';
  const declared = env.CAMPAIGN_HARNESS ? String(env.CAMPAIGN_HARNESS) : null;
  if (declared !== null && !/^[a-z][a-z0-9-]{0,31}$/u.test(declared))
    throw new Error(`CAMPAIGN_HARNESS must match ^[a-z][a-z0-9-]{0,31}$; got ${JSON.stringify(declared)}`);
  if (legacyCodex && declared !== null && declared !== 'codex')
    throw new Error(`CODEX_CAMPAIGN_CONTEXT_HOOKS=1 conflicts with CAMPAIGN_HARNESS=${declared}`);
  const harness = declared ?? (legacyCodex ? 'codex' : null);
  if (hooks && harness === null) throw new Error('CAMPAIGN_CONTEXT_HOOKS=1 requires CAMPAIGN_HARNESS');
  if (!hooks) return { hooks: false, harness };
  // Harnesses that put a conversation id in tools/call _meta. Every other harness
  // runs one stdio server process per session, so the process is the conversation.
  const nativeThread = { codex: 'threadId' }[harness] ?? null;
  return { hooks: true, harness, nativeThread,
    processIdentity: nativeThread ? null : `${harness}-process-${randomUUID()}` };
}

let profile;
try { profile = harnessProfile(process.env); }
catch (error) { process.stderr.write(`${SERVER_NAME}: ${error.message}\n`); process.exit(2); }

const store = createStore();
const session = { binding_token: null };
const hookAdapter = profile.hooks ? await import('./hook-context.mjs') : null;
const threadContexts = new Map();

function runtimeIdentity(params) {
  if (!profile.nativeThread) return profile.processIdentity;
  const threadId = params?._meta?.[profile.nativeThread];
  if (typeof threadId !== 'string' || !threadId.trim() || threadId.length > 200) {
    throw new CampaignError('CAMPAIGN_RUNTIME_IDENTITY_REQUIRED', `Native ${profile.harness} conversation metadata is required; no campaign was selected.`, { mutated: false });
  }
  return threadId;
}

function runtimeContext(params) {
  const threadId = runtimeIdentity(params);
  if (!threadContexts.has(threadId)) threadContexts.set(threadId, {
    store: createStore(), session: { binding_token: null }, hook: {}, threadId,
  });
  return threadContexts.get(threadId);
}

function response(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function errorResponse(id, code, message, data) {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } };
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function toolResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function toolError(error) {
  const payload = error instanceof CampaignError
    ? error.toJSON()
    : {
        code: "INTERNAL_ERROR",
        message: "An unexpected tool error occurred; the operation outcome is unknown.",
        details: {
          mutated: null,
          next_action: "Inspect campaign state before considering a retry: use campaign_status when bound or campaign_list and campaign_detail when unbound. Do not repeat a write while its outcome remains unknown.",
        },
      };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function handle(request) {
  if (!request || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
    return errorResponse(request?.id ?? null, -32600, "Invalid JSON-RPC request");
  }
  const id = request.id ?? null;
  try {
    if (request.method === "notifications/initialized" || request.method === "notifications/cancelled") return null;
    if (request.method === "ping") return response(id, {});
    if (request.method === "shutdown") return response(id, null);
    if (request.method === "initialize") {
      return response(id, {
        protocolVersion: request.params?.protocolVersion || "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: "Campaign mode starts UNBOUND. Use campaign_list or campaign_search, inspect one campaign with campaign_detail, and bind it with campaign_bind after owner selection. Use campaign_status only after binding. Create a new record with campaign_create; it does not bind the session. Finish with campaign_finish, intentionally terminate with campaign_abandon, and clear only this session binding with campaign_unbind. campaign_open, campaign_resume, and campaign_close are retired and return DEPRECATED_TOOL. Binding never reloads hooks or changes the plugin manifest.",
      });
    }
    if (request.method === "tools/list") return response(id, {
      tools: hookAdapter ? [...TOOL_DEFINITIONS, hookAdapter.CONTEXT_TOOL] : TOOL_DEFINITIONS,
    });
    if (request.method === "tools/call") {
      const name = request.params?.name;
      const args = request.params?.arguments || {};
      try {
        if (hookAdapter) {
          if (name === hookAdapter.CONTEXT_TOOL.name && profile.nativeThread && !request.params?._meta?.[profile.nativeThread])
            return response(id, toolResult({}));
          const context = runtimeContext(request.params);
          if (name === hookAdapter.CONTEXT_TOOL.name) return response(id, toolResult(
            hookAdapter.contextHook(context.store, context.hook, args, context.threadId, context.session.binding_token),
          ));
          const actualArgs = name === 'campaign_bind' && args && typeof args === 'object' && !Array.isArray(args)
            ? { ...args, thread_id: context.threadId, client: profile.harness } : args;
          return response(id, toolResult(invokeTool(context.store, name, actualArgs, context.session)));
        }
        return response(id, toolResult(invokeTool(store, name, args, session)));
      } catch (error) {
        return response(id, toolError(error));
      }
    }
    return errorResponse(id, -32601, `Method not found: ${request.method}`);
  } catch (error) {
    if (error instanceof CampaignError) return errorResponse(id, -32001, error.message, error.toJSON());
    return errorResponse(id, -32603, error.message);
  }
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    write(errorResponse(null, -32700, "Parse error"));
    return;
  }
  const result = handle(request);
  if (result) write(result);
});

function close() {
  try {
    input.close();
    for (const context of threadContexts.values()) context.store.dispose();
    threadContexts.clear();
    store.dispose();
  } catch {
    // Shutdown must remain best effort for a stdio process.
  }
}

process.on("SIGINT", () => {
  close();
  process.exit(0);
});
process.on("SIGTERM", () => {
  close();
  process.exit(0);
});
process.stdin.on("end", () => {
  close();
});
