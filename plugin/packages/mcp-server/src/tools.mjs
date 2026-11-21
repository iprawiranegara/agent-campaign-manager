import { randomUUID } from "node:crypto";

import { CampaignError } from "../../campaign-core/src/core.mjs";

const text = { type: "string" };
const object = { type: "object" };
const array = { type: "array", items: text };
const integer = { type: "integer", minimum: 1 };

const outside = {
  campaign_list: {
    name: "campaign_list",
    title: "List campaigns",
    description: "List durable campaigns without selecting one. Use this before binding a session.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  campaign_search: {
    name: "campaign_search",
    title: "Search campaigns",
    description: "Search durable campaign summaries for an owner decision. Search never binds a session.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: text,
        lifecycle: text,
        phase: text,
        accountable_primary: text,
        scope_root: text,
        limit: { type: "integer", minimum: 1, maximum: 500 },
      },
    },
  },
  campaign_detail: {
    name: "campaign_detail",
    title: "Inspect campaign detail",
    description: "Inspect one exact campaign and receive its identity digest before binding. This is available only while unbound.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["campaign_id"],
      properties: { campaign_id: text },
    },
  },
  campaign_create: {
    name: "campaign_create",
    title: "Create campaign",
    description: "Create a new campaign after owner approval. Creation rejects an existing ID and leaves this session unbound.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["campaign_id", "objective", "scope_roots", "actor"],
      properties: {
        campaign_id: text,
        objective: text,
        scope_roots: { type: "array", items: text, minItems: 1 },
        actor: text,
        timestamp: text,
        charter: object,
        accountable_primary: text,
        profile: { type: "string", enum: ["research", "engineering", "research_delivery", "status_only"] },
      },
    },
  },
  campaign_bind: {
    name: "campaign_bind",
    title: "Bind session to campaign",
    description: "Attach this MCP session to an existing campaign after exact identity and version checks. Binding never changes durable campaign version.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["campaign_id", "expected_version", "identity_digest", "actor", "run_id", "thread_id"],
      properties: {
        campaign_id: text,
        expected_version: integer,
        identity_digest: text,
        actor: text,
        run_id: text,
        client: text,
        thread_id: text,
        parent_thread_id: text,
        agent_id: text,
        model: text,
        provider: text,
        adapter_version: text,
      },
    },
  },
};

const bound = {
  campaign_status: {
    name: "campaign_status",
    title: "Read bound campaign status",
    description: "Read the currently bound campaign. The default response is compact; use view=full only when the full event tail is needed.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { view: { type: "string", enum: ["compact", "full"] } },
    },
  },
  campaign_preflight: {
    name: "campaign_preflight",
    title: "Run campaign preflight",
    description: "Read authority order, scope, protected state, phase, and the next permitted action for the bound campaign.",
    inputSchema: { type: "object", additionalProperties: false, properties: { run_id: text } },
  },
  campaign_work_package: {
    name: "campaign_work_package",
    title: "Register work package",
    description: "Register one bounded parent or child task under the bound campaign.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["expected_version", "actor", "run_id", "work_package_id", "title", "allowed_paths"],
      properties: {
        expected_version: integer,
        actor: text,
        run_id: text,
        work_package_id: text,
        parent_work_package_id: text,
        title: text,
        objective: text,
        task: object,
        allowed_paths: { type: "array", items: text, minItems: 1 },
        forbidden_actions: array,
        required_governance: array,
        required_verification: array,
        stop_conditions: array,
        dependencies: array,
        authority_and_freshness_slice: object,
        required_inputs: array,
        expected_outputs: array,
        verification_checks: array,
        command_policy: object,
        receipt_schema_version: integer,
        status: text,
      },
    },
  },
  campaign_receipt: {
    name: "campaign_receipt",
    title: "Record campaign receipt",
    description: "Record source, method, command, test, review, or other evidence under a bound work package.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["expected_version", "actor", "run_id", "kind", "data"],
      properties: {
        expected_version: integer,
        actor: text,
        run_id: text,
        work_package_id: text,
        receipt_id: text,
        kind: text,
        status: text,
        data: object,
      },
    },
  },
  campaign_reconcile: {
    name: "campaign_reconcile",
    title: "Reconcile work package",
    description: "Accept, reject, request changes, or block a registered work package after parent review.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["expected_version", "actor", "run_id", "work_package_id", "outcome"],
      properties: {
        expected_version: integer,
        actor: text,
        run_id: text,
        work_package_id: text,
        outcome: { type: "string", enum: ["accepted", "rejected", "request_changes", "blocked"] },
        details: object,
      },
    },
  },
  campaign_update: {
    name: "campaign_update",
    title: "Update bound campaign",
    description: "Apply one expected-version checked lifecycle, phase, or work-package status update.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["expected_version", "actor"],
      properties: {
        expected_version: integer,
        actor: text,
        lifecycle: text,
        phase: object,
        work_package_id: text,
        work_package_status: text,
        details: object,
      },
    },
  },
  campaign_finish: {
    name: "campaign_finish",
    title: "Finish campaign",
    description: "Finish a bound campaign from its verifying/closing gate with final inventory and closeout evidence.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["expected_version", "actor", "run_id", "closeout"],
      properties: {
        expected_version: integer,
        actor: text,
        run_id: text,
        closure_kind: { type: "string", enum: ["FULL", "QUALIFIED"] },
        closeout: object,
      },
    },
  },
  campaign_abandon: {
    name: "campaign_abandon",
    title: "Abandon campaign",
    description: "Intentionally stop a bound campaign while preserving its evidence, reason, limitations, and checkpoint.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["expected_version", "actor", "run_id", "reason"],
      properties: {
        expected_version: integer,
        actor: text,
        run_id: text,
        reason: text,
        details: object,
        limitations: array,
      },
    },
  },
  campaign_unbind: {
    name: "campaign_unbind",
    title: "Unbind session",
    description: "Clear only this MCP session's campaign binding. It does not finish, abandon, or mutate the campaign.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
};

export const TOOL_DEFINITIONS = Object.freeze([
  ...Object.values(outside),
  ...Object.values(bound),
]);

const retired = Object.freeze({
  campaign_open: "Use campaign_create for a new campaign or campaign_detail then campaign_bind for an existing campaign.",
  campaign_resume: "Use campaign_detail followed by campaign_bind. A fresh session never resumes implicitly.",
  campaign_close: "Use campaign_finish. campaign_abandon is the separate intentional-termination operation.",
});

function invalid(code, message, details = {}) {
  throw new CampaignError(code, message, { ...details, mutated: false });
}

function requireObject(value, field = "arguments") {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid("INVALID_INPUT", `${field} must be an object`, { field, expected: "object", received: value });
  return value;
}

function requireUnbound(store, toolName) {
  if (store.binding) {
    invalid(toolName === "campaign_detail" ? "CAMPAIGN_BOUND_USE_STATUS" : "CAMPAIGN_ALREADY_BOUND", `${toolName} is available only while this session is unbound`, {
      tool: toolName,
      mode: "BOUND_ACTIVE",
      bound_campaign_id: store.binding.campaign_id,
      next_action: toolName === "campaign_detail" ? "campaign_status" : "campaign_unbind",
    });
  }
}

function sessionMode(store) {
  if (!store.binding) return "UNBOUND";
  const lifecycle = store.status().lifecycle;
  return ["CLOSED", "CLOSED_QUALIFIED", "ABORTED"].includes(lifecycle) ? "BOUND_TERMINAL" : "BOUND_ACTIVE";
}

function requireBinding(store, toolName, allowTerminal = false) {
  if (!store.binding) {
    invalid("CAMPAIGN_NOT_BOUND", `${toolName} requires an active campaign binding`, {
      tool: toolName,
      mode: "UNBOUND",
      next_action: "campaign_list -> campaign_detail -> campaign_bind",
    });
  }
  const campaign = store.status();
  const terminal = ["CLOSED", "CLOSED_QUALIFIED", "ABORTED"].includes(campaign.lifecycle);
  if (terminal && !allowTerminal) {
    invalid("CAMPAIGN_TERMINAL", `${toolName} is unavailable after finish or abandon`, {
      tool: toolName,
      mode: "BOUND_TERMINAL",
      lifecycle: campaign.lifecycle,
      next_action: "campaign_status or campaign_unbind",
    });
  }
  return { campaign, campaign_id: store.binding.campaign_id, binding: store.binding };
}

function compactStatus(status) {
  const terminal = ["CLOSED", "CLOSED_QUALIFIED", "ABORTED"].includes(status.lifecycle);
  return {
    schema_version: status.schema_version,
    mode: terminal ? "BOUND_TERMINAL" : "BOUND_ACTIVE",
    campaign_id: status.campaign_id,
    objective: status.objective,
    lifecycle: status.lifecycle,
    phase: status.phase,
    accountable_primary: status.accountable_primary,
    scope_roots: status.scope_roots,
    version: status.version,
    identity_digest: status.identity_digest,
    bound_run: status.bound_run,
    next_permitted_actions: status.next_permitted_actions,
    open_gates: status.gates.filter(({ status: gateStatus }) => gateStatus === "OPEN"),
    active_packages: status.work_packages.filter(({ status: packageStatus }) => !["ACCEPTED", "CANCELLED", "SUPERSEDED"].includes(packageStatus)),
    receipt_ids: status.receipts.map(({ receipt_id }) => receipt_id),
    recent_events: status.recent_events.slice(0, 8),
    durable_event_count: status.durable_event_count,
  };
}

function withBound(store, args) {
  const binding = requireBinding(store, "bound operation");
  return { ...args, campaign_id: binding.campaign_id };
}

function invokeRetired(name) {
  if (Object.hasOwn(retired, name)) {
    invalid("DEPRECATED_TOOL", `${name} is retired`, {
      tool: name,
      replacement: retired[name],
      next_action: retired[name],
    });
  }
}

function invokeToolInternal(store, name, args = {}, session = {}) {
  requireObject(args);
  invokeRetired(name);

  if (name === "campaign_list") return { ...store.list(), mode: sessionMode(store) };
  if (name === "campaign_search") return { ...store.search(args), mode: sessionMode(store) };
  if (name === "campaign_detail") {
    requireUnbound(store, name);
    return store.detail(args.campaign_id);
  }
  if (name === "campaign_create") {
    requireUnbound(store, name);
    return store.create(args);
  }
  if (name === "campaign_bind") {
    if (store.binding && store.binding.campaign_id !== args.campaign_id) {
      invalid("CAMPAIGN_ALREADY_BOUND", "This session is already bound to another campaign", {
        bound_campaign_id: store.binding.campaign_id,
        campaign_id: args.campaign_id,
        next_action: "campaign_unbind",
      });
    }
    const result = store.bind(args);
    session.binding_token ??= randomUUID();
    return { ...result, mode: "BOUND_ACTIVE", binding_token: session.binding_token };
  }
  if (name === "campaign_status") {
    const { campaign } = requireBinding(store, name, true);
    const status = store.status();
    return args.view === "full" ? status : compactStatus({ ...status, lifecycle: campaign.lifecycle });
  }
  if (name === "campaign_preflight") return store.preflight(withBound(store, args));
  if (name === "campaign_work_package") return store.workPackage(withBound(store, args));
  if (name === "campaign_receipt") return store.receipt(withBound(store, args));
  if (name === "campaign_reconcile") return store.reconcile(withBound(store, args));
  if (name === "campaign_update") return store.update(withBound(store, args));
  if (name === "campaign_finish") return store.finish(withBound(store, args));
  if (name === "campaign_abandon") return store.abandon(withBound(store, args));
  if (name === "campaign_unbind") {
    requireBinding(store, name, true);
    const result = store.unbind();
    session.binding_token = null;
    return result;
  }
  throw new CampaignError("UNKNOWN_TOOL", `Unknown campaign tool: ${name}`, {
    name,
    known_tools: TOOL_DEFINITIONS.map(({ name: toolName }) => toolName),
    mutated: false,
  });
}

export function invokeTool(store, name, args = {}, session = {}) {
  try {
    return invokeToolInternal(store, name, args, session);
  } catch (error) {
    if (!(error instanceof CampaignError)) throw error;
    const details = error.details;
    const status = store.binding ? "campaign_status" : "campaign_detail";
    const actions = {
      INVALID_INPUT: "Correct the named field using the stated requirements; retry once only if the correction is unambiguous.",
      INVALID_SCOPE: "Check the scope paths and supply valid absolute paths within the authorized scope.",
      SCOPE_VIOLATION: "Check the requested path against the authorized campaign scope; do not widen scope automatically.",
      CAMPAIGN_NOT_FOUND: "Use campaign_list or campaign_search and confirm the intended campaign before selecting it.",
      CAMPAIGN_ALREADY_EXISTS: "Use campaign_detail to inspect the existing campaign and confirm its identity; do not create a substitute automatically.",
      CAMPAIGN_VERSION_CONFLICT: `Refresh ${status}; retry once only if the same action is still intended and authorized.`,
      CAMPAIGN_IDENTITY_MISMATCH: "Stop the operation and verify the intended campaign; do not guess or retry the same payload.",
      INVALID_TRANSITION: `Inspect ${status}, the current lifecycle and any outstanding work before choosing a permitted action.`,
      INVALID_LIFECYCLE: `Inspect ${status} for the current lifecycle and permitted actions.`,
      INVALID_PROFILE: "Check the allowed profile values and select the one that matches the authorized campaign.",
      WORK_PACKAGE_NOT_FOUND: `Inspect ${status} and verify the intended work package identifier before retrying.`,
      COMPLETED_RECEIPT_REQUIRES_EVIDENCE: "Supply a summary and at least one evidence item from required_any; do not invent evidence.",
      STATE_INTEGRITY_ERROR: "Stop campaign writes and report the integrity error; inspect the authoritative state before recovery.",
      CORRUPT_STATE: "Stop campaign writes and report the integrity error; inspect the authoritative state before recovery.",
    };
    if (!details.next_action && actions[error.code]) details.next_action = actions[error.code];
    if (error.code === "INVALID_INPUT" && /^data\.artifacts\[\d+\]/.test(details.field ?? "")) {
      details.required_fields = ["artifact_id", "path", "risk", "creator"];
    }
    throw error;
  }
}
