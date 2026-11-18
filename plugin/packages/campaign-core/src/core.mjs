import { createHash, randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

import { openSqlite, SCHEMA_VERSION as SQLITE_SCHEMA_VERSION } from "./sqlite.mjs";

export const SCHEMA_VERSION = SQLITE_SCHEMA_VERSION;

export const PROFILE_REQUIREMENTS = Object.freeze({
  research: {
    required_method_layer: "co-researcher",
    required_execution_layer: null,
    required_skills: ["co-researcher:research-manager"],
    evidence_classes: ["source", "method", "claim"],
  },
  engineering: {
    required_method_layer: null,
    required_execution_layer: "superpowers",
    required_skills: ["superpowers:verification-before-completion"],
    evidence_classes: ["file", "test", "review"],
  },
  research_delivery: {
    required_method_layer: "co-researcher",
    required_execution_layer: "superpowers",
    required_skills: [
      "co-researcher:research-manager",
      "co-researcher:research-methodology",
      "superpowers:verification-before-completion",
    ],
    evidence_classes: ["source", "method", "claim", "file", "test", "review"],
  },
  status_only: {
    required_method_layer: null,
    required_execution_layer: null,
    required_skills: [],
    evidence_classes: ["status"],
  },
});

const LIFECYCLE_TRANSITIONS = Object.freeze({
  DRAFT: ["ORIENTING", "WAITING_OWNER", "ABORTED"],
  ORIENTING: ["READY", "EXECUTING", "WAITING_OWNER", "BLOCKED", "PAUSED", "FAILED", "ABORTED"],
  READY: ["EXECUTING", "WAITING_OWNER", "BLOCKED", "PAUSED", "ABORTED"],
  EXECUTING: ["VERIFYING", "WAITING_OWNER", "BLOCKED", "PAUSED", "FAILED", "ABORTED"],
  VERIFYING: ["CLOSING", "EXECUTING", "WAITING_OWNER", "BLOCKED", "PAUSED", "FAILED", "ABORTED"],
  CLOSING: ["CLOSED", "CLOSED_QUALIFIED", "WAITING_OWNER", "BLOCKED", "PAUSED", "ABORTED"],
  WAITING_OWNER: ["ORIENTING", "READY", "EXECUTING", "VERIFYING", "PAUSED", "ABORTED"],
  BLOCKED: ["ORIENTING", "READY", "EXECUTING", "PAUSED", "FAILED", "ABORTED"],
  PAUSED: ["ORIENTING", "READY", "EXECUTING", "WAITING_OWNER", "ABORTED"],
  FAILED: ["ORIENTING", "PAUSED", "ABORTED"],
  ABORTED: [],
  CLOSED: [],
  CLOSED_QUALIFIED: [],
});

const OMO_LIFECYCLES = new Set(Object.keys(LIFECYCLE_TRANSITIONS));
const OMO_WORK_PACKAGE_STATUSES = new Set([
  "DRAFT",
  "READY",
  "DISPATCHED",
  "IN_PROGRESS",
  "RESULT_UNRECONCILED",
  "ACCEPTED",
  "BLOCKED",
  "FAILED",
  "CANCELLED",
  "SUPERSEDED",
]);
const OMO_RECEIPT_STATUSES = new Set(["COMPLETED", "PARTIAL", "BLOCKED", "FAILED"]);
const TERMINAL_LIFECYCLES = new Set(["CLOSED", "CLOSED_QUALIFIED", "ABORTED"]);

export class CampaignError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CampaignError";
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return { code: this.code, message: this.message, details: this.details };
  }
}

function afterCommittedWrite(readResult) {
  try {
    return readResult();
  } catch (error) {
    if (error instanceof CampaignError) {
      error.details.mutated = true;
      error.details.next_action = "The write committed but its result could not be read. Inspect campaign state before taking further action; do not repeat the write.";
    }
    throw error;
  }
}

function invalid(field, message, expected, received) {
  const details = { field, expected, received, mutated: false };
  throw new CampaignError("INVALID_INPUT", message, details);
}

function requireString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    invalid(field, `${field} must be a non-empty string`, "non-empty string", value);
  }
  return value.trim();
}

function requireId(value, field) {
  const id = requireString(value, field);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{1,191}$/.test(id)) {
    invalid(field, `${field} must be 2–192 characters, start with a letter or digit, and contain only letters, digits, '.', '_', ':' or '-'`, "2–192 characters; starts with a letter or digit; remaining characters are letters, digits, '.', '_', ':' or '-'", id);
  }
  return id;
}

function requireCampaignId(value, field = "campaign_id") {
  if (typeof value !== "string" || value === "") {
    invalid(field, `${field} must be a non-empty string`, "OMO campaign identifier", value);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) {
    invalid(field, `${field} contains unsupported characters`, "OMO campaign identifier", value);
  }
  return value;
}

function requireObject(value, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(field, `${field} must be an object`, "object", value);
  }
  return value;
}

function requireStrictObject(value, field, allowedKeys) {
  const object = requireObject(value, field);
  const allowed = new Set(allowedKeys);
  const unexpected = Object.keys(object).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    invalid(field, `${field} contains unsupported fields`, allowedKeys, unexpected);
  }
  return object;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function canonicalRootValues(scopeRoots, field = "scope_roots") {
  if (!Array.isArray(scopeRoots)) {
    invalid(field, `${field} must be an array`, "array", scopeRoots);
  }
  const roots = scopeRoots.map((root, index) => normalize(resolve(requireString(root, `${field}[${index}]`))));
  return [...new Set(roots)].sort();
}

function canonicalCharter(charter) {
  const value = canonicalize(charter);
  if (value && typeof value === "object" && !Array.isArray(value) && Array.isArray(value.scope_roots)) {
    if (value.scope_roots.every((root) => typeof root === "string")) {
      value.scope_roots = canonicalRootValues(value.scope_roots, "charter.scope_roots");
    }
  }
  return value;
}

function canonicalJson(value) {
  const encoded = JSON.stringify(canonicalize(value));
  if (encoded === undefined) throw new CampaignError("INVALID_INPUT", "value must be JSON serializable", { mutated: false });
  return encoded;
}

function digest(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function now() {
  return new Date().toISOString();
}

const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function validIsoTimestamp(value) {
  return typeof value === "string" && ISO_TIMESTAMP_PATTERN.test(value.trim()) && Number.isFinite(Date.parse(value.trim()));
}

function timestamp(value) {
  if (value === undefined || value === null) return now();
  const text = requireString(value, "timestamp");
  const parsed = new Date(text);
  if (Number.isNaN(parsed.valueOf())) invalid("timestamp", "timestamp must be an ISO date", "ISO timestamp", value);
  return parsed.toISOString();
}

function json(value) {
  return canonicalJson(value);
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    throw new CampaignError("CORRUPT_STATE", "Campaign state contains invalid JSON", { mutated: false });
  }
}

function defaultDatabasePath() {
  const stateHome = process.env.XDG_STATE_HOME
    ? resolve(process.env.XDG_STATE_HOME)
    : join(homedir(), ".local", "state");
  return join(stateHome, "omo-research", "campaigns.sqlite3");
}

function normalizeRoots(scopeRoots) {
  if (!Array.isArray(scopeRoots) || scopeRoots.length === 0) {
    invalid("scope_roots", "scope_roots must contain at least one absolute path", "non-empty absolute path array", scopeRoots);
  }
  const roots = scopeRoots.map((root, index) => {
    const value = requireString(root, `scope_roots[${index}]`);
    if (!isAbsolute(value)) {
      throw new CampaignError("INVALID_SCOPE", "scope_roots must use absolute paths", {
        field: `scope_roots[${index}]`,
        expected: "absolute path",
        received: value,
        mutated: false,
      });
    }
    return normalize(resolve(value));
  });
  if (new Set(roots).size !== roots.length) {
    throw new CampaignError("INVALID_SCOPE", "scope_roots must not contain duplicates", {
      field: "scope_roots",
      expected: "unique absolute paths",
      received: roots,
      mutated: false,
    });
  }
  return roots.sort();
}

function contained(root, candidate) {
  const rel = relative(root, candidate);
  const firstSegment = rel.split(sep)[0];
  return rel === "" || (firstSegment !== ".." && !isAbsolute(rel));
}

function checkPathAgainstRoots(candidate, roots, field) {
  const value = requireString(candidate, field);
  if (!isAbsolute(value)) {
    throw new CampaignError("INVALID_SCOPE", `${field} must use an absolute path`, {
      field,
      expected: "absolute path",
      received: value,
      mutated: false,
    });
  }
  const normalized = normalize(resolve(value));
  const root = roots.find((entry) => contained(entry, normalized));
  if (!root) {
    throw new CampaignError("SCOPE_VIOLATION", `${field} is outside campaign scope`, {
      field,
      path: normalized,
      scope_roots: roots,
      mutated: false,
    });
  }
  if (existsSync(normalized)) {
    const rootReal = existsSync(root) ? realpathSync.native(root) : root;
    const candidateReal = realpathSync.native(normalized);
    if (!contained(rootReal, candidateReal)) {
      throw new CampaignError("SCOPE_VIOLATION", `${field} escapes scope through a symlink`, {
        field,
        path: normalized,
        mutated: false,
      });
    }
  }
  return normalized;
}

function normalizeProfile(profile) {
  const value = profile ?? "research_delivery";
  if (!Object.hasOwn(PROFILE_REQUIREMENTS, value)) {
    throw new CampaignError("INVALID_PROFILE", `Unknown campaign profile: ${value}`, {
      field: "profile",
      expected: Object.keys(PROFILE_REQUIREMENTS),
      received: value,
      mutated: false,
    });
  }
  return value;
}

function charterForProfile(charter, objective, scopeRoots, profile) {
  const selectedProfile = normalizeProfile(profile);
  const value = charter === undefined ? { objective, scope_roots: scopeRoots } : requireObject(charter, "charter");
  if (selectedProfile !== "research_delivery" && !Object.hasOwn(value, "profile")) {
    return { ...value, profile: selectedProfile };
  }
  return value;
}

function profileFromCharter(charter) {
  const candidate = charter?.profile ?? charter?.campaign_profile;
  return Object.hasOwn(PROFILE_REQUIREMENTS, candidate) ? candidate : "research_delivery";
}

function phaseFromCharter(charter) {
  return charter?.current_phase ?? charter?.phase ?? null;
}

function normalizePhase(value) {
  if (typeof value === "string") {
    const phaseId = requireString(value, "phase");
    return {
      phase_id: phaseId,
      checkpoint: `Legacy phase ${phaseId} normalized to an OMO phase contract`,
      next_gate: "owner-review",
      hard_stops: ["legacy phase string normalized to OMO CampaignPhase"],
      authority_basis: "Codex campaign core compatibility normalization",
    };
  }
  return campaignPhase(value, "phase");
}

function campaignPhase(value, field) {
  const source = requireStrictObject(value, field, ["phase_id", "checkpoint", "next_gate", "hard_stops", "authority_basis"]);
  const phase = {
    phase_id: requireString(source.phase_id, `${field}.phase_id`),
    checkpoint: requireString(source.checkpoint, `${field}.checkpoint`),
    next_gate: requireString(source.next_gate, `${field}.next_gate`),
    hard_stops: stringArray(source.hard_stops, `${field}.hard_stops`),
    authority_basis: requireString(source.authority_basis, `${field}.authority_basis`),
  };
  if (phase.hard_stops.length === 0) invalid(`${field}.hard_stops`, `${field}.hard_stops must contain at least one entry`, "non-empty string array", phase.hard_stops);
  return phase;
}

function stringArray(value, field) {
  if (!Array.isArray(value)) invalid(field, `${field} must be an array`, "array", value);
  return value.map((item, index) => requireString(item, `${field}[${index}]`));
}

function objectStringMap(value, field) {
  requireObject(value, field);
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    result[requireString(key, `${field}.key`)] = requireString(entry, `${field}.${key}`);
  }
  return result;
}

const SHA256_PATTERN = /^sha256:[a-f0-9]{16,128}$/;

function requireSha256(value, field) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    invalid(field, `${field} must be a sha256 fingerprint`, "sha256:<16-128 lowercase hexadecimal characters>", value);
  }
  return value;
}

function receiptArtifacts(value) {
  if (!Array.isArray(value)) invalid("data.artifacts", "data.artifacts must be an array", "array", value);
  return value.map((entry, index) => {
    const field = `data.artifacts[${index}]`;
    const source = requireStrictObject(entry, field, ["artifact_id", "path", "risk", "creator"]);
    if (!['standard', 'high_risk'].includes(source.risk)) {
      invalid(`${field}.risk`, `${field}.risk must be standard or high_risk`, ["standard", "high_risk"], source.risk);
    }
    return {
      artifact_id: requireString(source.artifact_id, `${field}.artifact_id`),
      path: requireString(source.path, `${field}.path`),
      risk: source.risk,
      creator: requireString(source.creator, `${field}.creator`),
    };
  });
}

function receiptCommands(value) {
  if (!Array.isArray(value)) invalid("data.commands", "data.commands must be an array", "array", value);
  return value.map((entry, index) => {
    const field = `data.commands[${index}]`;
    const source = requireStrictObject(entry, field, ["command_hash", "executable", "environment_fingerprint", "raw_command"]);
    const command = {
      command_hash: requireSha256(source.command_hash, `${field}.command_hash`),
      executable: requireString(source.executable, `${field}.executable`),
      environment_fingerprint: requireSha256(source.environment_fingerprint, `${field}.environment_fingerprint`),
    };
    if (Object.hasOwn(source, "raw_command")) command.raw_command = requireString(source.raw_command, `${field}.raw_command`);
    return command;
  });
}

function receiptVerification(value) {
  if (!Array.isArray(value)) invalid("data.verification", "data.verification must be an array", "array", value);
  return value.map((entry, index) => {
    const field = `data.verification[${index}]`;
    const source = requireStrictObject(entry, field, ["artifact_id", "actor", "outcome", "detail"]);
    if (!["PASS", "FAIL"].includes(source.outcome)) {
      invalid(`${field}.outcome`, `${field}.outcome must be PASS or FAIL`, ["PASS", "FAIL"], source.outcome);
    }
    return {
      artifact_id: requireString(source.artifact_id, `${field}.artifact_id`),
      actor: requireString(source.actor, `${field}.actor`),
      outcome: source.outcome,
      detail: requireString(source.detail, `${field}.detail`),
    };
  });
}

function workerReceipt({ receiptId, campaignId, packageId, status, kind, data }) {
  const source = requireObject(data, "data");
  const summary = typeof source.summary === "string" && source.summary.trim() !== ""
    ? source.summary.trim()
    : `${requireString(kind ?? "evidence", "kind")} receipt`;
  const continuationToken = source.continuation_token ?? null;
  if (continuationToken !== null && (typeof continuationToken !== "string" || continuationToken.trim() === "")) {
    invalid("data.continuation_token", "continuation_token must be null or a non-empty string", "nullable string", continuationToken);
  }
  return {
    schema_version: 1,
    receipt_id: receiptId,
    campaign_id: campaignId,
    package_id: packageId,
    status,
    summary,
    files_read: stringArray(source.files_read ?? [], "data.files_read"),
    files_created: stringArray(source.files_created ?? [], "data.files_created"),
    files_modified: stringArray(source.files_modified ?? [], "data.files_modified"),
    files_deleted: stringArray(source.files_deleted ?? [], "data.files_deleted"),
    artifacts: receiptArtifacts(source.artifacts === undefined ? [] : source.artifacts),
    commands: receiptCommands(source.commands === undefined ? [] : source.commands),
    verification: receiptVerification(source.verification === undefined ? [] : source.verification),
    decisions_proposed: stringArray(source.decisions_proposed ?? [], "data.decisions_proposed"),
    governance_conflicts: stringArray(source.governance_conflicts ?? [], "data.governance_conflicts"),
    blockers: stringArray(source.blockers ?? [], "data.blockers"),
    continuation_token: continuationToken === null ? null : continuationToken.trim(),
  };
}

function hasCompletedReceiptEvidence(receipt) {
  if (!receipt || receipt.status !== "COMPLETED" || typeof receipt.summary !== "string" || receipt.summary.trim() === "") return false;
  return ["files_read", "files_created", "files_modified", "files_deleted", "artifacts", "commands", "verification", "decisions_proposed"]
    .some((field) => Array.isArray(receipt[field]) && receipt[field].length > 0);
}

function limitationNamesPackageId(limitation, packageId) {
  const escaped = packageId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9._:-])${escaped}(?=$|[^A-Za-z0-9._:-])`).test(limitation);
}

function hasFreshCompletedReceiptEvidence(connection, campaignId, packageId) {
  const events = connection.query("SELECT event_type, new_version, payload_json FROM event WHERE campaign_id = ? ORDER BY new_version", [campaignId]);
  let latestReceiptStatus = null;
  for (const event of events) {
    if (event.event_type !== "campaign_update") continue;
    const payload = parseJson(event.payload_json, {});
    if (payload.update_type === "work_package_upserted" && payload.work_package?.package_id === packageId) {
      latestReceiptStatus = null;
    } else if (payload.update_type === "work_package_status" && payload.package_id === packageId) {
      if (payload.status !== "ACCEPTED") latestReceiptStatus = null;
    } else if (payload.update_type === "receipt_recorded" && payload.receipt?.package_id === packageId) {
      latestReceiptStatus = hasCompletedReceiptEvidence(payload.receipt) ? "COMPLETED" : payload.receipt?.status ?? "UNKNOWN";
    }
  }
  return latestReceiptStatus === "COMPLETED";
}

function workPackageCloseProblems(connection, campaignId) {
  const rows = connection.query("SELECT package_id, status FROM work_package WHERE campaign_id = ? ORDER BY package_id", [campaignId]);
  const events = connection.query("SELECT event_type, payload_json FROM event WHERE campaign_id = ? ORDER BY new_version", [campaignId]);
  const dispositions = new Map();
  for (const event of events) {
    if (event.event_type !== "campaign_update") continue;
    const payload = parseJson(event.payload_json, {});
    if (payload.update_type === "work_package_status") dispositions.set(payload.package_id, payload);
  }
  return rows.filter((row) => {
    if (row.status === "ACCEPTED") return !hasFreshCompletedReceiptEvidence(connection, campaignId, row.package_id);
    if (["CANCELLED", "SUPERSEDED"].includes(row.status)) {
      const disposition = dispositions.get(row.package_id);
      return disposition?.status !== row.status || typeof disposition.reason !== "string" || disposition.reason.trim() === "";
    }
    return true;
  }).map((row) => ({
    ...row,
    reason: row.status === "ACCEPTED" ? "fresh_completed_evidence_required"
      : ["CANCELLED", "SUPERSEDED"].includes(row.status) ? "disposition_reason_required"
        : "nonterminal_status",
  }));
}

function profileFor(profile) {
  const selected = PROFILE_REQUIREMENTS[profile] ? profile : "research_delivery";
  const requirement = PROFILE_REQUIREMENTS[selected];
  return {
    profile: selected,
    required_method_layer: requirement.required_method_layer,
    required_execution_layer: requirement.required_execution_layer,
    required_skills: [...requirement.required_skills],
    evidence_classes: [...requirement.evidence_classes],
  };
}

function nextActions(campaign) {
  if (!campaign) return [];
  const status = campaign.lifecycle;
  const actions = ["campaign_list", "campaign_detail"];
  if (TERMINAL_LIFECYCLES.has(status)) return actions;
  actions.push("campaign_status", "campaign_bind", "campaign_preflight");
  if (status === "DRAFT") actions.push("campaign_update", "transition:ORIENTING", "transition:WAITING_OWNER", "campaign_abandon");
  if (["ORIENTING", "READY", "EXECUTING", "VERIFYING", "CLOSING", "WAITING_OWNER", "BLOCKED", "PAUSED", "FAILED"].includes(status)) {
    actions.push("campaign_work_package", "campaign_receipt", "campaign_reconcile", "campaign_update", "campaign_finish", "campaign_abandon");
    for (const target of LIFECYCLE_TRANSITIONS[status] || []) actions.push(`transition:${target}`);
  }
  return [...new Set(actions)];
}

function rowPayload(row) {
  return parseJson(row.payload_json, {});
}

export class CampaignStore {
  constructor(options = {}) {
    const hasDbPath = Object.hasOwn(options, "dbPath") || Object.hasOwn(options, "databasePath");
    const hasStateDir = Object.hasOwn(options, "stateDir");
    const suppliedStateDir = options.stateDir;
    const explicitEnvironmentState = !hasDbPath && !hasStateDir && process.env.CODEX_RESEARCH_CAMPAIGN_STATE_DIR
      ? resolve(process.env.CODEX_RESEARCH_CAMPAIGN_STATE_DIR)
      : null;
    const rawDbPath = options.dbPath ?? options.databasePath ?? (hasStateDir
      ? join(resolve(suppliedStateDir), "campaigns.sqlite3")
      : explicitEnvironmentState
        ? join(explicitEnvironmentState, "campaigns.sqlite3")
        : defaultDatabasePath());
    this.dbPath = resolve(rawDbPath);
    this.stateDir = resolve(options.stateDir ?? dirname(this.dbPath));
    this.allowCreate = options.allowCreate === true;
    this.db = openSqlite({ path: this.dbPath, allowCreate: this.allowCreate });
    this.binding = null;
    // Keep this flag explicit in the constructor: a path selected by default is
    // always opened through the adapter's fail-closed production branch.
    this.productionPath = !hasDbPath && !hasStateDir && !explicitEnvironmentState;
  }

  dispose() {
    this.db.close();
  }

  #scopeRoots(campaignId) {
    return this.db.query("SELECT path FROM scope_root WHERE campaign_id = ? ORDER BY scope_root_id", [campaignId]).map((row) => row.path);
  }

  #getRow(campaignId) {
    return this.db.query("SELECT * FROM campaign WHERE campaign_id = ?", [campaignId])[0] ?? null;
  }

  /**
   * Read the immutable opening contract from the durable OMO event journal.
   * Materialized campaign fields may carry mutable phase metadata, so they
   * are never used as the source of identity.
   */
  #openingIdentity(campaignId) {
    const rows = this.db.query(
      "SELECT event_id, event_type, actor, timestamp, previous_version, new_version, payload_json FROM event WHERE campaign_id = ? ORDER BY new_version ASC, event_id ASC LIMIT 2",
      [campaignId],
    );
    const opening = rows[0];
    const stateError = (reason, received = undefined) => {
      const details = {
        campaign_id: campaignId,
        reason,
        expected: "immutable campaign_open event at previous_version 0 and new_version 1",
        mutated: false,
      };
      if (received !== undefined) details.received = received;
      throw new CampaignError("STATE_INTEGRITY_ERROR", "Campaign immutable opening identity is missing or invalid", details);
    };
    if (!opening) stateError("opening_event_missing", "no event");
    if (opening.event_type !== "campaign_open" || opening.previous_version !== 0 || opening.new_version !== 1) {
      stateError("opening_event_invalid", {
        event_id: opening.event_id,
        event_type: opening.event_type,
        previous_version: opening.previous_version,
        new_version: opening.new_version,
      });
    }
    if (typeof opening.actor !== "string" || opening.actor.trim() === "") stateError("opening_actor_invalid", opening.actor);
    const openingTimestamp = typeof opening.timestamp === "string" ? opening.timestamp.trim() : "";
    if (!validIsoTimestamp(openingTimestamp)) {
      stateError("opening_timestamp_invalid", opening.timestamp);
    }

    let payload;
    try {
      payload = parseJson(opening.payload_json, null);
    } catch (error) {
      stateError("opening_payload_invalid", error instanceof CampaignError ? error.message : String(error));
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) stateError("opening_payload_not_object", payload);

    const objective = typeof payload.objective === "string" && payload.objective.trim() !== ""
      ? payload.objective.trim()
      : null;
    if (!objective) stateError("opening_objective_invalid", payload.objective);

    let scopeRoots;
    try {
      scopeRoots = normalizeRoots(payload.scope_roots);
    } catch (error) {
      stateError("opening_scope_roots_invalid", error instanceof CampaignError ? error.details?.received ?? error.message : String(error));
    }

    if (!Object.hasOwn(payload, "charter") || payload.charter === null) stateError("opening_charter_missing_or_null", payload.charter);
    const charter = payload.charter;
    if (typeof charter !== "object" || Array.isArray(charter)) stateError("opening_charter_invalid", charter);

    if (!Object.hasOwn(payload, "accountable_primary") || payload.accountable_primary === null) {
      stateError("opening_accountable_primary_missing_or_null", payload.accountable_primary);
    }
    const accountablePrimary = payload.accountable_primary;
    if (typeof accountablePrimary !== "string" || accountablePrimary.trim() === "") {
      stateError("opening_accountable_primary_invalid", accountablePrimary);
    }

    let normalizedCharter;
    try {
      normalizedCharter = canonicalCharter(charter);
    } catch (error) {
      stateError("opening_charter_invalid", error instanceof CampaignError ? error.details?.received ?? error.message : String(error));
    }

    return {
      campaign_id: campaignId,
      objective,
      scope_roots: scopeRoots,
      charter: normalizedCharter,
      accountable_primary: accountablePrimary.trim(),
      event_id: opening.event_id,
      actor: opening.actor.trim(),
      timestamp: openingTimestamp,
    };
  }

  #validateIntegrity(campaignId, row = this.#getRow(campaignId)) {
    const fail = (reason, expected = undefined, received = undefined) => {
      const details = { campaign_id: campaignId, reason, mutated: false };
      if (expected !== undefined) details.expected = expected;
      if (received !== undefined) details.received = received;
      throw new CampaignError("STATE_INTEGRITY_ERROR", "Campaign event journal and materialized state disagree", details);
    };
    if (!row) throw new CampaignError("CAMPAIGN_NOT_FOUND", `Campaign not found: ${campaignId}`, { campaign_id: campaignId, mutated: false });

    let opening;
    try {
      opening = this.#openingIdentity(campaignId);
    } catch (error) {
      if (error instanceof CampaignError && error.code === "STATE_INTEGRITY_ERROR") throw error;
      fail("opening_event_invalid", "valid immutable opening event", error instanceof Error ? error.message : String(error));
    }
    const events = this.db.query(
      "SELECT event_id, campaign_id, event_type, actor, timestamp, previous_version, new_version, payload_json FROM event WHERE campaign_id = ? ORDER BY new_version ASC, event_id ASC",
      [campaignId],
    );
    if (events.length === 0) fail("event_chain_empty", "opening event", "no event");

    const replay = {
      lifecycle: "DRAFT",
      phase: phaseFromCharter(opening.charter),
      charter: opening.charter,
      scope_roots: [...opening.scope_roots],
      work_packages: new Map(),
      receipts: new Map(),
      runs: new Map(),
      version: 0,
    };
    for (const [index, event] of events.entries()) {
      if (event.campaign_id !== campaignId) fail("event_campaign_mismatch", campaignId, event.campaign_id);
      if (typeof event.actor !== "string" || event.actor.trim() === "") fail("event_actor_invalid", "non-empty actor", event.actor);
      if (!validIsoTimestamp(event.timestamp)) fail("event_timestamp_invalid", "ISO timestamp", event.timestamp);
      if (!Number.isInteger(event.previous_version) || !Number.isInteger(event.new_version) || event.previous_version !== replay.version || event.new_version !== replay.version + 1) {
        fail("event_version_gap", { previous_version: replay.version, new_version: replay.version + 1 }, { previous_version: event.previous_version, new_version: event.new_version, event_id: event.event_id });
      }
      let payload;
      try {
        payload = parseJson(event.payload_json, null);
      } catch (error) {
        fail("event_payload_invalid", "valid JSON object", error instanceof Error ? error.message : String(error));
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) fail("event_payload_not_object", "object", payload);
      if (index === 0) {
        if (event.event_id !== opening.event_id || event.event_type !== "campaign_open" || event.previous_version !== 0 || event.new_version !== 1) {
          fail("opening_event_invalid", "campaign_open v0->v1", { event_id: event.event_id, event_type: event.event_type, previous_version: event.previous_version, new_version: event.new_version });
        }
      } else if (event.event_type === "campaign_update") {
        const updateType = payload.update_type;
        if (updateType === "lifecycle_transition") {
          if (!OMO_LIFECYCLES.has(payload.lifecycle)) fail("lifecycle_payload_invalid", [...OMO_LIFECYCLES], payload.lifecycle);
          replay.lifecycle = payload.lifecycle;
        } else if (updateType === "phase_transition") {
          let phase;
          try {
            requireStrictObject(payload, "phase_transition", ["update_type", "phase"]);
            phase = campaignPhase(payload.phase, "phase_transition.phase");
          } catch (error) {
            fail(
              "phase_transition_event_invalid",
              "strict OMO phase transition payload",
              error instanceof CampaignError ? { message: error.message, details: error.details } : String(error),
            );
          }
          replay.phase = phase;
          replay.charter = { ...replay.charter, current_phase: phase };
        } else if (updateType === "governance_snapshot") {
          try {
            replay.scope_roots = normalizeRoots(payload.snapshot?.scope_roots);
          } catch (error) {
            fail("governance_snapshot_invalid", "absolute scope roots", error instanceof Error ? error.message : String(error));
          }
        } else if (updateType === "work_package_upserted") {
          const packageValue = payload.work_package;
          if (!packageValue || typeof packageValue !== "object" || Array.isArray(packageValue) || typeof packageValue.package_id !== "string") fail("work_package_event_invalid", "OMO work package contract", packageValue);
          replay.work_packages.set(packageValue.package_id, { contract: packageValue, status: packageValue.status });
        } else if (updateType === "work_package_status") {
          if (typeof payload.package_id !== "string" || !OMO_WORK_PACKAGE_STATUSES.has(payload.status)) fail("work_package_status_event_invalid", "package_id/status", payload);
          const current = replay.work_packages.get(payload.package_id);
          if (!current) fail("work_package_status_without_package", payload.package_id, payload.status);
          current.status = payload.status;
        } else if (updateType === "receipt_recorded") {
          const receipt = payload.receipt;
          if (!receipt || typeof receipt !== "object" || typeof receipt.receipt_id !== "string") fail("receipt_event_invalid", "OMO worker receipt", receipt);
          replay.receipts.set(receipt.receipt_id, receipt);
        } else if (updateType === "run_registered") {
          const run = payload.run;
          if (!run || typeof run !== "object" || typeof run.run_id !== "string") fail("run_event_invalid", "OMO run record", run);
          replay.runs.set(run.run_id, run);
        } else if (updateType === "charter_confirmed") {
          if (!payload.charter || typeof payload.charter !== "object" || Array.isArray(payload.charter)) fail("charter_confirmed_invalid", "charter object", payload.charter);
          replay.charter = { ...replay.charter, confirmed_charter: payload.charter };
        } else if (["deliverable_upserted", "gate_updated", "decision_recorded", "risk_recorded"].includes(updateType)) {
          // These OMO materializations are outside the Codex compatibility
          // surface; their event shape is still part of the durable chain.
        } else {
          fail("event_update_type_unknown", "OMO campaign update type", updateType);
        }
      } else if (event.event_type === "campaign_close") {
        if (!["FULL", "QUALIFIED"].includes(payload.closure_kind) || !Array.isArray(payload.limitations)) fail("close_event_invalid", "closure_kind/limitations", payload);
        replay.lifecycle = payload.closure_kind === "FULL" ? "CLOSED" : "CLOSED_QUALIFIED";
      } else if (event.event_type === "receipt_attached") {
        if (typeof payload.receipt_id !== "string") fail("receipt_attachment_invalid", "receipt_id", payload);
        if (!replay.receipts.has(payload.receipt_id)) fail("receipt_attachment_without_receipt", payload.receipt_id);
      } else if (event.event_type === "run_observed") {
        if (typeof payload.run_id !== "string") fail("run_observed_invalid", "run_id", payload);
        const run = replay.runs.get(payload.run_id);
        if (!run) fail("run_observed_without_run", payload.run_id);
        run.status = payload.status;
        run.last_observed_at = payload.last_observed_at;
      } else {
        fail("event_type_unknown", "OMO event type", event.event_type);
      }
      replay.version = event.new_version;
    }

    if (row.version !== replay.version) fail("campaign_version_mismatch", replay.version, row.version);
    if (row.objective !== opening.objective) fail("materialized_objective_drift", opening.objective, row.objective);
    if (row.accountable_primary !== opening.accountable_primary) fail("materialized_accountable_primary_drift", opening.accountable_primary, row.accountable_primary);
    let materializedCharterValue;
    try {
      materializedCharterValue = parseJson(row.charter_json, null);
    } catch (error) {
      fail("materialized_charter_invalid", "valid charter JSON", error instanceof Error ? error.message : String(error));
    }
    let materializedCharter = materializedCharterValue;
    if (materializedCharterValue && typeof materializedCharterValue === "object" && !Array.isArray(materializedCharterValue)) {
      try {
        materializedCharter = canonicalCharter(materializedCharterValue);
      } catch (error) {
        fail("materialized_charter_invalid", "canonical charter object", error instanceof Error ? error.message : String(error));
      }
    }
    if (!materializedCharter || canonicalJson(materializedCharter) !== canonicalJson(replay.charter)) fail("materialized_charter_drift", replay.charter, materializedCharter);
    if (row.lifecycle !== replay.lifecycle) fail("materialized_lifecycle_drift", replay.lifecycle, row.lifecycle);
    const materializedRoots = this.#scopeRoots(campaignId).sort();
    const replayRoots = [...replay.scope_roots].sort();
    if (canonicalJson(materializedRoots) !== canonicalJson(replayRoots)) fail("materialized_scope_drift", replayRoots, materializedRoots);

    const packageRows = this.db.query("SELECT package_id, status, contract_json FROM work_package WHERE campaign_id = ? ORDER BY package_id", [campaignId]);
    if (packageRows.length !== replay.work_packages.size) fail("materialized_work_package_set_drift", [...replay.work_packages.keys()], packageRows.map((item) => item.package_id));
    for (const packageRow of packageRows) {
      const expectedPackage = replay.work_packages.get(packageRow.package_id);
      if (!expectedPackage || packageRow.status !== expectedPackage.status) fail("materialized_work_package_drift", expectedPackage, { package_id: packageRow.package_id, status: packageRow.status });
      const materializedContract = parseJson(packageRow.contract_json, null);
      if (!materializedContract || canonicalJson(materializedContract) !== canonicalJson(expectedPackage.contract)) fail("materialized_work_package_contract_drift", expectedPackage.contract, materializedContract);
    }

    const receiptRows = this.db.query("SELECT receipt_id, package_id, status, created_at, receipt_json FROM receipt WHERE campaign_id = ? ORDER BY receipt_id", [campaignId]);
    const receiptRowsById = new Map(receiptRows.map((item) => [item.receipt_id, item]));
    for (const receiptId of replay.receipts.keys()) {
      if (!receiptRowsById.has(receiptId)) fail("materialized_receipt_missing", receiptId, receiptRows.map((item) => item.receipt_id));
    }
    const consumedImplicitReceiptEvents = new Set();
    for (const receiptRow of receiptRows) {
      const expectedReceipt = replay.receipts.get(receiptRow.receipt_id);
      const materializedReceipt = parseJson(receiptRow.receipt_json, null);
      if (expectedReceipt && (receiptRow.package_id !== expectedReceipt.package_id || receiptRow.status !== expectedReceipt.status || canonicalJson(materializedReceipt) !== canonicalJson(expectedReceipt))) {
        fail("materialized_receipt_drift", expectedReceipt, { receipt_id: receiptRow.receipt_id, package_id: receiptRow.package_id, status: receiptRow.status, receipt: materializedReceipt });
      }
      if (expectedReceipt) continue;
      const implicit = events.find((event) => {
        if (consumedImplicitReceiptEvents.has(event.event_id) || event.event_type !== "campaign_update" || event.timestamp !== receiptRow.created_at) return false;
        const payload = parseJson(event.payload_json, {});
        if (payload.update_type !== "work_package_status" || payload.package_id !== receiptRow.package_id) return false;
        const expectedStatus = payload.status === "ACCEPTED" ? "COMPLETED" : payload.status === "BLOCKED" ? "BLOCKED" : payload.status === "FAILED" ? "FAILED" : "PARTIAL";
        return expectedStatus === receiptRow.status;
      });
      if (!implicit) fail("materialized_receipt_unjournaled", "receipt_recorded or reconcile event", { receipt_id: receiptRow.receipt_id, package_id: receiptRow.package_id, created_at: receiptRow.created_at });
      if (!materializedReceipt || materializedReceipt.package_id !== receiptRow.package_id || materializedReceipt.status !== receiptRow.status || materializedReceipt.receipt_id !== receiptRow.receipt_id) {
        fail("materialized_receipt_drift", "receipt identity/status matching its reconcile event", { receipt_id: receiptRow.receipt_id, package_id: receiptRow.package_id, status: receiptRow.status, receipt: materializedReceipt });
      }
      consumedImplicitReceiptEvents.add(implicit.event_id);
    }

    const runRows = this.db.query("SELECT run_id, status, last_observed_at, run_json FROM run_record WHERE campaign_id = ? ORDER BY run_id", [campaignId]);
    if (runRows.length !== replay.runs.size) fail("materialized_run_set_drift", [...replay.runs.keys()], runRows.map((item) => item.run_id));
    for (const runRow of runRows) {
      const expectedRun = replay.runs.get(runRow.run_id);
      const materializedRun = parseJson(runRow.run_json, null);
      if (!expectedRun || runRow.status !== expectedRun.status || runRow.last_observed_at !== expectedRun.last_observed_at || canonicalJson(materializedRun) !== canonicalJson(expectedRun)) {
        fail("materialized_run_drift", expectedRun, { run_id: runRow.run_id, status: runRow.status, last_observed_at: runRow.last_observed_at, run: materializedRun });
      }
    }
    return true;
  }

  #record(row) {
    if (!row) return null;
    const opening = this.#openingIdentity(row.campaign_id);
    const currentCharter = parseJson(row.charter_json, {});
    if (row.objective !== opening.objective || row.accountable_primary !== opening.accountable_primary) {
      throw new CampaignError("STATE_INTEGRITY_ERROR", "Materialized campaign identity disagrees with the immutable opening event", {
        campaign_id: row.campaign_id,
        reason: "materialized_identity_drift",
        expected: {
          objective: opening.objective,
          accountable_primary: opening.accountable_primary,
        },
        received: {
          objective: row.objective,
          accountable_primary: row.accountable_primary,
        },
        mutated: false,
      });
    }
    const charter = opening.charter;
    const scopeRoots = opening.scope_roots;
    const persistedRun = this.db.query(
      "SELECT run_id FROM run_record WHERE campaign_id = ? ORDER BY last_observed_at DESC, run_id ASC LIMIT 1",
      [row.campaign_id],
    )[0]?.run_id;
    const latestRun = persistedRun ?? (this.binding?.campaign_id === row.campaign_id ? this.binding.run_id : null);
    return {
      campaign_id: row.campaign_id,
      objective: opening.objective,
      objective_digest: digest(opening.objective),
      charter,
      charter_digest: digest(charter),
      scope_roots: scopeRoots,
      scope_roots_digest: digest(scopeRoots),
      accountable_primary: opening.accountable_primary,
      profile: profileFromCharter(charter),
      lifecycle: row.lifecycle,
      phase: phaseFromCharter(currentCharter),
      version: row.version,
      created_at: row.created_at,
      updated_at: row.updated_at,
      last_run_id: latestRun,
    };
  }

  #requireCampaign(campaignId) {
    const row = this.#getRow(campaignId);
    if (!row) throw new CampaignError("CAMPAIGN_NOT_FOUND", `Campaign not found: ${campaignId}`, { campaign_id: campaignId, mutated: false });
    this.#validateIntegrity(campaignId, row);
    return this.#record(row);
  }

  #runRows(campaignId) {
    return this.db.query(
      "SELECT * FROM run_record WHERE campaign_id = ? ORDER BY last_observed_at DESC, run_id ASC LIMIT 50",
      [campaignId],
    ).map((row) => ({
      run_id: row.run_id,
      campaign_id: row.campaign_id,
      package_id: row.package_id,
      work_package_id: row.package_id,
      runner_type: row.runner_type,
      session_or_process_id: row.session_or_process_id,
      cwd: row.cwd,
      command_hash: row.command_hash,
      environment_fingerprint: row.environment_fingerprint,
      run: parseJson(row.run_json, {}),
      status: row.status,
      started_at: row.started_at,
      last_observed_at: row.last_observed_at,
      last_verified_checkpoint: row.last_verified_checkpoint,
    }));
  }

  #workPackageRows(campaignId) {
    return this.db.query(
      "SELECT * FROM work_package WHERE campaign_id = ? ORDER BY created_at DESC, package_id ASC LIMIT 100",
      [campaignId],
    ).map((row) => {
      const contract = parseJson(row.contract_json, {});
      return {
        ...contract,
        campaign_id: row.campaign_id,
        package_id: row.package_id,
        work_package_id: row.package_id,
        parent_work_package_id: contract.parent_work_package_id ?? null,
        title: contract.title ?? row.objective,
        objective: row.objective,
        task: contract.task ?? contract.task_json ?? {},
        allowed_paths: contract.allowed_paths ?? [],
        forbidden_actions: contract.forbidden_actions ?? [],
        required_governance: contract.required_governance ?? [],
        required_verification: contract.required_verification ?? contract.verification_checks ?? [],
        stop_conditions: contract.stop_conditions ?? [],
        dependencies: parseJson(row.dependencies_json, contract.dependencies ?? []),
        status: row.status,
        created_at: row.created_at,
        updated_at: row.updated_at,
      };
    });
  }

  #receiptRows(campaignId) {
    return this.db.query(
      "SELECT * FROM receipt WHERE campaign_id = ? ORDER BY created_at DESC, receipt_id ASC LIMIT 100",
      [campaignId],
    ).map((row) => {
      const value = parseJson(row.receipt_json, {});
      return {
        ...value,
        receipt_id: row.receipt_id,
        campaign_id: row.campaign_id,
        package_id: row.package_id,
        work_package_id: row.package_id,
        status: row.status,
        receipt: value,
        created_at: row.created_at,
      };
    });
  }

  #eventRows(campaignId) {
    return this.db.query("SELECT * FROM event WHERE campaign_id = ? ORDER BY new_version ASC", [campaignId]).map((row) => {
      const payload = rowPayload(row);
      return {
        event_id: row.event_id,
        campaign_id: row.campaign_id,
        event_type: row.event_type,
        action: row.event_type,
        actor: row.actor,
        timestamp: row.timestamp,
        created_at: row.timestamp,
        previous_version: row.previous_version,
        prior_version: row.previous_version,
        new_version: row.new_version,
        payload,
        data: payload,
      };
    });
  }

  #detailRecord(campaignId) {
    const campaign = this.#requireCampaign(campaignId);
    const authorities = this.db.query(
      "SELECT authority_source_id, path, authority_class, precedence, modified_at, hash, freshness_json, created_at FROM authority_source WHERE campaign_id = ? ORDER BY precedence ASC, authority_source_id ASC",
      [campaignId],
    ).map((row) => ({ ...row, freshness: parseJson(row.freshness_json, {}) }));
    const deliverables = this.db.query(
      "SELECT deliverable_id, campaign_id, title, acceptance_rule, status, details_json, created_at, updated_at FROM deliverable WHERE campaign_id = ? ORDER BY deliverable_id ASC",
      [campaignId],
    ).map((row) => ({ ...row, details: parseJson(row.details_json, {}) }));
    const gates = this.db.query(
      "SELECT gate_id, campaign_id, gate_class, status, authority, resolution_json, created_at, resolved_at FROM gate WHERE campaign_id = ? ORDER BY gate_id ASC",
      [campaignId],
    ).map((row) => ({ ...row, resolution: parseJson(row.resolution_json, []) }));
    const decisions = this.db.query(
      "SELECT decision_id, campaign_id, status, basis, owner_status, affected_objects_json, created_at, updated_at FROM decision WHERE campaign_id = ? ORDER BY decision_id ASC",
      [campaignId],
    ).map((row) => ({ ...row, affected_objects: parseJson(row.affected_objects_json, []) }));
    const risks = this.db.query(
      "SELECT risk_issue_id, campaign_id, title, severity, owner, status, disposition, created_at, updated_at FROM risk_issue WHERE campaign_id = ? ORDER BY risk_issue_id ASC",
      [campaignId],
    );
    const artifacts = this.db.query(
      "SELECT artifact_id, campaign_id, package_id, identity, path_or_uri, hash, lifecycle, metadata_json, created_at, updated_at FROM artifact WHERE campaign_id = ? ORDER BY artifact_id ASC",
      [campaignId],
    ).map((row) => ({ ...row, metadata: parseJson(row.metadata_json, {}) }));
    const events = this.#eventRows(campaignId);
    return {
      schema_version: SCHEMA_VERSION,
      ...campaign,
      identity_digest: this.identityDigest(campaign),
      profile_requirements: profileFor(campaign.profile),
      next_permitted_actions: nextActions(campaign),
      authority_sources: authorities,
      deliverables,
      gates,
      decisions,
      risks,
      artifacts,
      runs: this.#runRows(campaignId),
      work_packages: this.#workPackageRows(campaignId),
      receipts: this.#receiptRows(campaignId),
      durable_event_count: events.length,
      event_history: events,
      recent_events: events.slice(-20).reverse(),
    };
  }

  identityDigest(campaignOrId) {
    const campaign = typeof campaignOrId === "string" ? this.#requireCampaign(requireCampaignId(campaignOrId)) : campaignOrId;
    if (!campaign || typeof campaign !== "object") invalid("campaign", "campaign is required", "campaign object", campaign);
    const campaignId = requireCampaignId(campaign.campaign_id);
    const row = this.#getRow(campaignId);
    if (!row) throw new CampaignError("CAMPAIGN_NOT_FOUND", `Campaign not found: ${campaignId}`, { campaign_id: campaignId, mutated: false });
    this.#validateIntegrity(campaignId, row);
    const opening = this.#openingIdentity(campaignId);
    return digest({
      campaign_id: opening.campaign_id,
      objective: opening.objective,
      charter: opening.charter,
      scope_roots: opening.scope_roots,
      accountable_primary: opening.accountable_primary,
    });
  }

  list() {
    const rows = this.db.query("SELECT * FROM campaign ORDER BY updated_at DESC, campaign_id ASC");
    return { campaigns: rows.map((row) => {
      this.#validateIntegrity(row.campaign_id, row);
      const campaign = this.#record(row);
      return {
        campaign_id: campaign.campaign_id,
        objective: campaign.objective,
        objective_digest: campaign.objective_digest,
        lifecycle: campaign.lifecycle,
        phase: campaign.phase,
        accountable_primary: campaign.accountable_primary,
        scope_roots: campaign.scope_roots,
        version: campaign.version,
        created_at: campaign.created_at,
        updated_at: campaign.updated_at,
        last_run_id: campaign.last_run_id,
        identity_digest: this.identityDigest(campaign),
      };
    }) };
  }

  search({ query = "", lifecycle, phase, accountable_primary: accountablePrimary, scope_root: scopeRoot, limit = 50 } = {}) {
    const text = query === undefined || query === null ? "" : requireString(query, "query");
    if (lifecycle !== undefined && !OMO_LIFECYCLES.has(lifecycle)) {
      invalid("lifecycle", "lifecycle must be an OMO campaign lifecycle", [...OMO_LIFECYCLES], lifecycle);
    }
    const phaseText = phase === undefined || phase === null ? null : requireString(phase, "phase");
    const ownerText = accountablePrimary === undefined || accountablePrimary === null
      ? null
      : requireString(accountablePrimary, "accountable_primary");
    let scopeText = null;
    if (scopeRoot !== undefined && scopeRoot !== null) {
      const candidate = requireString(scopeRoot, "scope_root");
      if (!isAbsolute(candidate)) invalid("scope_root", "scope_root must be an absolute path", "absolute path", candidate);
      scopeText = normalize(resolve(candidate));
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      invalid("limit", "limit must be an integer between 1 and 500", "integer 1..500", limit);
    }
    const normalizedQuery = text.toLowerCase();
    const campaigns = this.list().campaigns.filter((campaign) => {
      if (lifecycle !== undefined && campaign.lifecycle !== lifecycle) return false;
      if (ownerText !== null && campaign.accountable_primary !== ownerText) return false;
      if (phaseText !== null && campaign.phase?.phase_id !== phaseText) return false;
      if (scopeText !== null && !campaign.scope_roots.includes(scopeText)) return false;
      if (!normalizedQuery) return true;
      return [campaign.campaign_id, campaign.objective, campaign.accountable_primary, campaign.phase?.phase_id ?? ""]
        .some((value) => String(value).toLowerCase().includes(normalizedQuery));
    });
    return { campaigns: campaigns.slice(0, limit), query: text, limit };
  }

  detail(campaignId) {
    return this.#detailRecord(requireCampaignId(campaignId));
  }

  status(campaignId = null) {
    const requested = campaignId === null || campaignId === undefined ? this.binding?.campaign_id : requireCampaignId(campaignId);
    if (!requested) throw new CampaignError("CAMPAIGN_NOT_BOUND", "No campaign is bound to this session", { mutated: false });
    if (this.binding && this.binding.campaign_id !== requested) {
      throw new CampaignError("CAMPAIGN_BOUND_USE_STATUS", "Status is scoped to the bound campaign", {
        campaign_id: requested,
        bound_campaign_id: this.binding.campaign_id,
        mutated: false,
      });
    }
    const detail = this.#detailRecord(requested);
    const boundRun = this.binding?.campaign_id === requested ? this.binding : null;
    if (boundRun && !detail.runs.some((run) => run.run_id === boundRun.run_id)) {
      detail.runs.unshift({ ...boundRun, status: "RUNNING", package_id: null, work_package_id: null });
    }
    return {
      ...detail,
      bound_run: boundRun,
      phase_is_not_identity: true,
    };
  }

  unbind() {
    if (!this.binding) {
      throw new CampaignError("CAMPAIGN_NOT_BOUND", "No campaign is bound to this session", { mutated: false });
    }
    const previous = this.binding;
    this.binding = null;
    return {
      mode: "UNBOUND",
      previous_binding: previous,
      mutated: false,
    };
  }

  #identityMismatches(campaign, supplied) {
    const opening = this.#openingIdentity(campaign.campaign_id);
    const mismatches = {};
    const fields = [
      ["objective", opening.objective, supplied.objective],
      ["charter", canonicalCharter(opening.charter), canonicalCharter(supplied.charter)],
      ["scope_roots", opening.scope_roots, supplied.scope_roots],
      ["accountable_primary", opening.accountable_primary, supplied.accountable_primary],
    ];
    for (const [field, expected, received] of fields) {
      if (canonicalJson(expected) !== canonicalJson(received)) mismatches[field] = { expected, received };
    }
    return mismatches;
  }

  create({
    campaign_id: campaignId,
    objective,
    scope_roots: scopeRoots,
    actor,
    charter,
    accountable_primary: accountablePrimary,
    profile = "research_delivery",
    timestamp: createdTimestamp,
  }) {
    const id = requireCampaignId(campaignId);
    const text = requireString(objective, "objective");
    const roots = normalizeRoots(scopeRoots);
    const principal = requireString(actor, "actor");
    const owner = requireString(accountablePrimary ?? principal, "accountable_primary");
    const openingCharter = charterForProfile(charter, text, roots, profile);
    const persistedCharter = canonicalCharter(openingCharter);
    const existing = this.#getRow(id);
    if (existing) throw new CampaignError("CAMPAIGN_ALREADY_EXISTS", `Campaign already exists: ${id}`, { campaign_id: id, version: existing.version, mutated: false });
    const createdAt = timestamp(createdTimestamp);
    this.db.transaction((connection) => {
      connection.exec(
        "INSERT INTO campaign(campaign_id, objective, charter_json, lifecycle, accountable_primary, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [id, text, json(persistedCharter), "DRAFT", owner, 1, createdAt, createdAt],
      );
      for (const [index, path] of roots.entries()) {
        connection.exec(
          "INSERT INTO scope_root(scope_root_id, campaign_id, path, attribution_class, created_at) VALUES (?, ?, ?, ?, ?)",
          [`${id}:scope:${index + 1}`, id, path, "PRIMARY_DIRECT", createdAt],
        );
      }
      connection.exec(
        "INSERT INTO event(event_id, campaign_id, event_type, actor, timestamp, previous_version, new_version, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [randomUUID(), id, "campaign_open", principal, createdAt, 0, 1, json({ objective: text, scope_roots: roots, charter: persistedCharter, accountable_primary: owner })],
      );
    });
    return afterCommittedWrite(() => ({ ...this.detail(id), created: true, resumed: false, mode: "create_new", mutated: true }));
  }

  /** Compatibility facade for the pre-contract API. New clients should use create/detail/bind. */
  open({
    campaign_id: campaignId,
    objective,
    scope_roots: scopeRoots,
    actor,
    mode = "create_new",
    charter,
    accountable_primary,
    profile = "research_delivery",
    client = "codex-desktop",
    thread_id: threadId = "unbound",
    parent_thread_id: parentThreadId = null,
    agent_id: agentId = "primary-orchestrator",
    model = null,
    provider = null,
    adapter_version: adapterVersion = "0.2.0",
    run_id: runId = null,
  }) {
    const id = requireCampaignId(campaignId);
    if (mode !== "create_new" && mode !== "resume_exact") {
      invalid("mode", "mode must be create_new or resume_exact", ["create_new", "resume_exact"], mode);
    }
    let campaign;
    if (mode === "create_new") {
      campaign = this.create({ campaign_id: id, objective, scope_roots: scopeRoots, actor, charter, accountable_primary, profile });
    } else {
      const existing = this.detail(id);
      const suppliedRoots = normalizeRoots(scopeRoots);
      const suppliedObjective = requireString(objective, "objective");
      const supplied = {
        objective: suppliedObjective,
        charter: charterForProfile(charter, suppliedObjective, suppliedRoots, profile),
        scope_roots: suppliedRoots,
        accountable_primary: requireString(accountable_primary ?? actor, "accountable_primary"),
      };
      const mismatches = this.#identityMismatches(existing, supplied);
      if (Object.keys(mismatches).length > 0) {
        throw new CampaignError("CAMPAIGN_IDENTITY_MISMATCH", "Existing campaign identity does not match the supplied contract", {
          campaign_id: id,
          mismatches,
          existing_version: existing.version,
          mutated: false,
        });
      }
      campaign = existing;
    }
    let binding = null;
    if (runId) {
      binding = this.bind({
        campaign_id: id,
        expected_version: campaign.version,
        identity_digest: this.identityDigest(campaign),
        actor,
        run_id: runId,
        client,
        thread_id: threadId,
        parent_thread_id: parentThreadId,
        agent_id: agentId,
        model,
        provider,
        adapter_version: adapterVersion,
      });
    }
    return { ...(binding ?? campaign), resumed: mode === "resume_exact", mode, deprecated: true };
  }

  bind({
    campaign_id: campaignId,
    expected_version: expectedVersion,
    identity_digest: suppliedDigest,
    actor,
    run_id: runId,
    client = "codex-desktop",
    thread_id: threadId,
    parent_thread_id: parentThreadId = null,
    agent_id: agentId = "primary-orchestrator",
    model = null,
    provider = null,
    adapter_version: adapterVersion = "0.2.0",
  }) {
    const id = requireCampaignId(campaignId);
    if (!Number.isInteger(expectedVersion)) invalid("expected_version", "expected_version must be an integer", "integer", expectedVersion);
    const principal = requireString(actor, "actor");
    const run = requireId(runId, "run_id");
    const thread = requireString(threadId, "thread_id");
    const campaign = this.#requireCampaign(id);
    if (TERMINAL_LIFECYCLES.has(campaign.lifecycle)) {
      throw new CampaignError("CAMPAIGN_TERMINAL", "A terminal campaign cannot be bound for work", { campaign_id: id, lifecycle: campaign.lifecycle, mutated: false });
    }
    const actualDigest = this.identityDigest(campaign);
    const digestValue = requireString(suppliedDigest, "identity_digest");
    if (digestValue !== actualDigest) {
      throw new CampaignError("CAMPAIGN_IDENTITY_MISMATCH", "Thread binding identity digest does not match campaign", {
        campaign_id: id,
        expected_identity_digest: actualDigest,
        supplied_identity_digest: digestValue,
        field: "identity_digest",
        expected: actualDigest,
        received: digestValue,
        mutated: false,
      });
    }
    if (campaign.version !== expectedVersion) {
      throw new CampaignError("CAMPAIGN_VERSION_CONFLICT", "Campaign version does not match expected_version", {
        campaign_id: id,
        expected_version: expectedVersion,
        actual_version: campaign.version,
        mutated: false,
      });
    }
    const existing = this.binding;
    if (existing && existing.campaign_id !== id) {
      throw new CampaignError("CAMPAIGN_ALREADY_BOUND", "This session is already bound to another campaign", {
        campaign_id: id,
        bound_campaign_id: existing.campaign_id,
        mutated: false,
      });
    }
    const binding = {
      campaign_id: id,
      run_id: run,
      client: requireString(client, "client"),
      thread_id: thread,
      parent_thread_id: parentThreadId,
      agent_id: requireString(agentId, "agent_id"),
      model,
      provider,
      adapter_version: requireString(adapterVersion, "adapter_version"),
      identity_digest: actualDigest,
      actor: principal,
      bound_at: now(),
    };
    this.binding = binding;
    return { ...this.detail(id), bound_run: binding, binding, mutated: false };
  }

  #requireRun(campaignId, runId) {
    const id = requireId(runId, "run_id");
    const persisted = this.db.query("SELECT * FROM run_record WHERE run_id = ? AND campaign_id = ?", [id, campaignId])[0];
    if (persisted) return this.#runRows(campaignId).find((row) => row.run_id === id);
    if (this.binding?.campaign_id === campaignId && this.binding.run_id === id) return this.binding;
    throw new CampaignError("RUN_NOT_FOUND", `Run not found for campaign: ${id}`, { campaign_id: campaignId, run_id: id, mutated: false });
  }

  #mutate({ campaignId, expectedVersion, actor, eventType, payload, callback }) {
    const id = requireCampaignId(campaignId);
    if (!Number.isInteger(expectedVersion)) invalid("expected_version", "expected_version must be an integer", "integer", expectedVersion);
    const principal = requireString(actor, "actor");
    this.db.transaction((connection) => {
      const row = connection.query("SELECT * FROM campaign WHERE campaign_id = ?", [id])[0];
      if (!row) throw new CampaignError("CAMPAIGN_NOT_FOUND", `Campaign not found: ${id}`, { campaign_id: id, mutated: false });
      if (row.version !== expectedVersion) {
        throw new CampaignError("CAMPAIGN_VERSION_CONFLICT", "Campaign version does not match expected_version", {
          campaign_id: id,
          expected_version: expectedVersion,
          actual_version: row.version,
          mutated: false,
        });
      }
      this.#validateIntegrity(id, row);
      const campaign = this.#record(row);
      const changedAt = now();
      callback(connection, campaign, changedAt);
      const newVersion = row.version + 1;
      connection.exec("UPDATE campaign SET version = ?, updated_at = ? WHERE campaign_id = ?", [newVersion, changedAt, id]);
      connection.exec(
        "INSERT INTO event(event_id, campaign_id, event_type, actor, timestamp, previous_version, new_version, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [randomUUID(), id, eventType, principal, changedAt, row.version, newVersion, json(payload ?? {})],
      );
    });
    return afterCommittedWrite(() => this.status(id));
  }

  preflight({ campaign_id: campaignId, run_id: runId = null }) {
    const id = requireCampaignId(campaignId);
    const campaign = this.#requireCampaign(id);
    const run = runId ? this.#requireRun(id, runId) : this.binding?.campaign_id === id ? this.binding : null;
    const charter = campaign.charter ?? {};
    return {
      ...this.status(id),
      bound_run: run,
      authority_order: ["owner_charter", "campaign_core", "repository_governance", "skills_and_hooks"],
      required_authorities: charter.required_authorities ?? charter.authority_order ?? [],
      protected_state: charter.protected_state ?? charter.protected_surfaces ?? [],
      hard_stops: charter.hard_stops ?? [],
      authority_sources: this.db.query("SELECT * FROM authority_source WHERE campaign_id = ? ORDER BY precedence, authority_source_id", [id]),
      phase_is_not_identity: true,
    };
  }

  workPackage({
    campaign_id: campaignId,
    expected_version: expectedVersion,
    actor,
    run_id: runId,
    work_package_id: workPackageId,
    package_id: packageIdAlias,
    parent_work_package_id: parentWorkPackageId = null,
    title,
    objective,
    task = {},
    allowed_paths: allowedPaths,
    forbidden_actions: forbiddenActions = [],
    required_governance: requiredGovernance = [],
    required_verification: requiredVerification = [],
    stop_conditions: stopConditions = [],
    dependencies = [],
    status = "DRAFT",
    authority_and_freshness_slice: authorityAndFreshnessSlice = null,
    required_inputs: requiredInputs = [],
    expected_outputs: expectedOutputs = [],
    verification_checks: verificationChecks = [],
    command_policy: commandPolicyInput = null,
    receipt_schema_version: receiptSchemaVersion = 1,
  }) {
    const id = requireCampaignId(campaignId);
    const run = requireId(runId, "run_id");
    this.#requireRun(id, run);
    const packageId = requireId(workPackageId ?? packageIdAlias, "work_package_id");
    const name = requireString(title ?? objective, "title");
    const taskObject = requireObject(task, "task");
    const campaign = this.#requireCampaign(id);
    if (!Array.isArray(allowedPaths) || allowedPaths.length === 0) invalid("allowed_paths", "allowed_paths must contain at least one path", "non-empty absolute path array", allowedPaths);
    const paths = allowedPaths.map((entry, index) => checkPathAgainstRoots(entry, campaign.scope_roots, `allowed_paths[${index}]`));
    const arrays = {
      forbidden_actions: stringArray(forbiddenActions, "forbidden_actions"),
      required_governance: stringArray(requiredGovernance, "required_governance"),
      required_verification: stringArray(requiredVerification, "required_verification"),
      stop_conditions: stringArray(stopConditions, "stop_conditions"),
      dependencies: stringArray(dependencies, "dependencies"),
      required_inputs: stringArray(requiredInputs, "required_inputs"),
      expected_outputs: stringArray(expectedOutputs, "expected_outputs"),
      verification_checks: stringArray(verificationChecks, "verification_checks"),
    };
    if (!OMO_WORK_PACKAGE_STATUSES.has(status)) {
      throw new CampaignError("INVALID_WORK_PACKAGE_STATUS", `Unsupported work-package status: ${status}`, { field: "status", expected: [...OMO_WORK_PACKAGE_STATUSES], received: status, mutated: false });
    }
    if (["ACCEPTED", "CANCELLED", "SUPERSEDED"].includes(status)) {
      throw new CampaignError("WORK_PACKAGE_TERMINAL_STATUS_REQUIRES_RECONCILIATION", "New work packages must start in a nonterminal state", { field: "status", received: status, mutated: false });
    }
    if (receiptSchemaVersion !== 1) invalid("receipt_schema_version", "receipt_schema_version must be 1", 1, receiptSchemaVersion);
    const authoritySlice = authorityAndFreshnessSlice ?? { snapshot_id: `${id}:snapshot:current`, source_hashes: {} };
    requireObject(authoritySlice, "authority_and_freshness_slice");
    const authority = {
      snapshot_id: requireString(authoritySlice.snapshot_id, "authority_and_freshness_slice.snapshot_id"),
      source_hashes: objectStringMap(authoritySlice.source_hashes ?? {}, "authority_and_freshness_slice.source_hashes"),
    };
    const commandPolicy = commandPolicyInput ?? { allow_raw_command_retention: false, allowed_executables: ["none"] };
    requireObject(commandPolicy, "command_policy");
    if (typeof commandPolicy.allow_raw_command_retention !== "boolean") {
      invalid("command_policy.allow_raw_command_retention", "allow_raw_command_retention must be boolean", "boolean", commandPolicy.allow_raw_command_retention);
    }
    const normalizedCommandPolicy = {
      allow_raw_command_retention: commandPolicy.allow_raw_command_retention,
      allowed_executables: stringArray(commandPolicy.allowed_executables, "command_policy.allowed_executables"),
    };
    if (normalizedCommandPolicy.allowed_executables.length === 0) {
      invalid("command_policy.allowed_executables", "allowed_executables must contain at least one entry", "non-empty string array", normalizedCommandPolicy.allowed_executables);
    }
    if (parentWorkPackageId) {
      const parent = this.db.query("SELECT package_id FROM work_package WHERE package_id = ? AND campaign_id = ?", [parentWorkPackageId, id])[0];
      if (!parent) throw new CampaignError("WORK_PACKAGE_NOT_FOUND", `Parent work package not found: ${parentWorkPackageId}`, { campaign_id: id, work_package_id: parentWorkPackageId, mutated: false });
    }
    const contract = {
      package_id: packageId,
      campaign_id: id,
      status,
      objective: requireString(objective ?? name, "objective"),
      scope_roots: campaign.scope_roots,
      allowed_paths: paths,
      forbidden_actions: arrays.forbidden_actions,
      authority_and_freshness_slice: authority,
      dependencies: arrays.dependencies,
      required_inputs: arrays.required_inputs,
      expected_outputs: arrays.expected_outputs,
      verification_checks: arrays.verification_checks,
      stop_conditions: arrays.stop_conditions,
      command_policy: normalizedCommandPolicy,
      receipt_schema_version: 1,
    };
    return this.#mutate({
      campaignId: id,
      expectedVersion,
      actor,
      eventType: "campaign_update",
      payload: { update_type: "work_package_upserted", work_package: contract },
      callback: (connection, current, changedAt) => {
        if (connection.query("SELECT package_id FROM work_package WHERE package_id = ?", [packageId])[0]) {
          throw new CampaignError("WORK_PACKAGE_ALREADY_EXISTS", `Work package already exists: ${packageId}`, { work_package_id: packageId, mutated: false });
        }
        connection.exec(
          "INSERT INTO work_package(package_id, campaign_id, status, objective, dependencies_json, contract_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          [packageId, id, status, contract.objective, json(arrays.dependencies), json(contract), changedAt, changedAt],
        );
      },
    });
  }

  receipt({
    campaign_id: campaignId,
    expected_version: expectedVersion,
    actor,
    run_id: runId,
    work_package_id: workPackageId = null,
    package_id: packageIdAlias = null,
    receipt_id: receiptIdInput = null,
    kind,
    status = null,
    data = {},
  }) {
    const id = requireCampaignId(campaignId);
    const run = requireId(runId, "run_id");
    this.#requireRun(id, run);
    const receiptKind = requireString(kind ?? "evidence", "kind");
    const payloadData = requireObject(data, "data");
    const packageId = workPackageId ?? packageIdAlias;
    if (!packageId) {
      invalid("work_package_id", "worker receipts require a work package", "non-empty work package identifier", packageId);
    }
    const packageValue = requireId(packageId, "work_package_id");
    if (!this.db.query("SELECT package_id FROM work_package WHERE package_id = ? AND campaign_id = ?", [packageValue, id])[0]) {
      throw new CampaignError("WORK_PACKAGE_NOT_FOUND", `Work package not found: ${packageValue}`, { work_package_id: packageValue, campaign_id: id, mutated: false });
    }
    const receiptId = receiptIdInput ? requireId(receiptIdInput, "receipt_id") : `${id}:receipt:${randomUUID()}`;
    const selectedStatus = status ?? payloadData.status ?? "COMPLETED";
    if (!OMO_RECEIPT_STATUSES.has(selectedStatus)) {
      throw new CampaignError("INVALID_RECEIPT_STATUS", `Unsupported receipt status: ${selectedStatus}`, { field: "status", expected: [...OMO_RECEIPT_STATUSES], received: selectedStatus, mutated: false });
    }
    if (selectedStatus === "COMPLETED" && !hasCompletedReceiptEvidence({ ...payloadData, status: selectedStatus })) {
      throw new CampaignError("COMPLETED_RECEIPT_REQUIRES_EVIDENCE", "A completed receipt needs a summary and at least one evidence item", {
        work_package_id: packageValue,
        required_any: ["files_read", "files_created", "files_modified", "files_deleted", "artifacts", "commands", "verification", "decisions_proposed"],
        mutated: false,
      });
    }
    const receipt = workerReceipt({ receiptId, campaignId: id, packageId: packageValue, status: selectedStatus, kind: receiptKind, data: payloadData });
    return this.#mutate({
      campaignId: id,
      expectedVersion,
      actor,
      eventType: "campaign_update",
      payload: { update_type: "receipt_recorded", receipt },
      callback: (connection, _campaign, changedAt) => {
        if (connection.query("SELECT receipt_id FROM receipt WHERE receipt_id = ?", [receiptId])[0]) {
          throw new CampaignError("RECEIPT_ALREADY_EXISTS", `Receipt already exists: ${receiptId}`, { receipt_id: receiptId, mutated: false });
        }
        connection.exec(
          "INSERT INTO receipt(receipt_id, campaign_id, package_id, status, receipt_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          [receiptId, id, packageValue, selectedStatus, json(receipt), changedAt],
        );
      },
    });
  }

  reconcile({
    campaign_id: campaignId,
    expected_version: expectedVersion,
    actor,
    run_id: runId,
    work_package_id: workPackageId,
    package_id: packageIdAlias,
    outcome,
    details = {},
  }) {
    const id = requireCampaignId(campaignId);
    const run = requireId(runId, "run_id");
    this.#requireRun(id, run);
    const packageId = requireId(workPackageId ?? packageIdAlias, "work_package_id");
    const normalizedOutcome = requireString(outcome, "outcome").toLowerCase();
    if (!["accepted", "rejected", "request_changes", "blocked"].includes(normalizedOutcome)) {
      throw new CampaignError("INVALID_INPUT", "outcome must be accepted, rejected, request_changes, or blocked", { field: "outcome", expected: ["accepted", "rejected", "request_changes", "blocked"], received: normalizedOutcome, mutated: false });
    }
    requireObject(details, "details");
    if (!this.db.query("SELECT package_id FROM work_package WHERE package_id = ? AND campaign_id = ?", [packageId, id])[0]) {
      throw new CampaignError("WORK_PACKAGE_NOT_FOUND", `Work package not found: ${packageId}`, { work_package_id: packageId, campaign_id: id, mutated: false });
    }
    const packageStatus = normalizedOutcome === "accepted" ? "ACCEPTED" : normalizedOutcome === "rejected" ? "FAILED" : normalizedOutcome === "blocked" ? "BLOCKED" : "RESULT_UNRECONCILED";
    const receiptStatus = normalizedOutcome === "accepted" ? "COMPLETED" : normalizedOutcome === "blocked" ? "BLOCKED" : normalizedOutcome === "rejected" ? "FAILED" : "PARTIAL";
    const receiptId = `${id}:receipt:${randomUUID()}`;
    const receipt = workerReceipt({
      receiptId,
      campaignId: id,
      packageId,
      status: receiptStatus,
      kind: "reconciliation",
      data: { summary: `Reconciliation outcome: ${normalizedOutcome}; ${JSON.stringify(details)}`, blockers: normalizedOutcome === "blocked" ? [JSON.stringify(details)] : [] },
    });
    return this.#mutate({
      campaignId: id,
      expectedVersion,
      actor,
      eventType: "campaign_update",
      payload: { update_type: "work_package_status", package_id: packageId, status: packageStatus },
      callback: (connection, _campaign, changedAt) => {
        if (normalizedOutcome === "accepted" && !hasFreshCompletedReceiptEvidence(connection, id, packageId)) {
          throw new CampaignError("ACCEPTANCE_REQUIRES_FRESH_COMPLETED_EVIDENCE", "The parent can accept a package only after its latest reopen has a completed evidence receipt", { work_package_id: packageId, mutated: false });
        }
        const result = connection.exec("UPDATE work_package SET status = ?, updated_at = ? WHERE package_id = ? AND campaign_id = ?", [packageStatus, changedAt, packageId, id]);
        if (result?.changes === 0) throw new CampaignError("WORK_PACKAGE_NOT_FOUND", `Work package not found: ${packageId}`, { work_package_id: packageId, mutated: false });
        connection.exec(
          "INSERT INTO receipt(receipt_id, campaign_id, package_id, status, receipt_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          [receiptId, id, packageId, receiptStatus, json(receipt), changedAt],
        );
      },
    });
  }

  update({ campaign_id: campaignId, expected_version: expectedVersion, actor, lifecycle, phase, details = {}, work_package_id: workPackageId = null, work_package_status: workPackageStatus = null }) {
    const id = requireCampaignId(campaignId);
    if (lifecycle !== undefined && (!OMO_LIFECYCLES.has(lifecycle) || TERMINAL_LIFECYCLES.has(lifecycle))) {
      throw new CampaignError("INVALID_LIFECYCLE", `Unsupported lifecycle: ${lifecycle}`, { field: "lifecycle", expected: [...OMO_LIFECYCLES], received: lifecycle, mutated: false });
    }
    const normalizedPhase = phase !== undefined ? normalizePhase(phase) : undefined;
    requireObject(details, "details");
    if (workPackageStatus !== null && !OMO_WORK_PACKAGE_STATUSES.has(workPackageStatus)) {
      throw new CampaignError("INVALID_WORK_PACKAGE_STATUS", `Unsupported work-package status: ${workPackageStatus}`, { field: "work_package_status", expected: [...OMO_WORK_PACKAGE_STATUSES], received: workPackageStatus, mutated: false });
    }
    if (workPackageStatus === "ACCEPTED") {
      throw new CampaignError("WORK_PACKAGE_ACCEPTANCE_REQUIRES_RECONCILIATION", "Use campaign_reconcile after reviewing a completed evidence receipt", { work_package_id: workPackageId, mutated: false });
    }
    if (["CANCELLED", "SUPERSEDED"].includes(workPackageStatus) && (typeof details.reason !== "string" || details.reason.trim() === "")) {
      throw new CampaignError("WORK_PACKAGE_DISPOSITION_REQUIRES_REASON", "Cancelled or superseded work packages need an explicit reason", { work_package_id: workPackageId, status: workPackageStatus, mutated: false });
    }
    const mutationKinds = [lifecycle !== undefined, normalizedPhase !== undefined, workPackageStatus !== null].filter(Boolean).length;
    if (mutationKinds !== 1) {
      invalid("update", "update must change exactly one lifecycle, phase, or work-package status field", "one mutation kind", { lifecycle, phase, work_package_status: workPackageStatus });
    }
    const statusPackageId = workPackageStatus !== null ? requireId(workPackageId, "work_package_id") : null;
    const payload = lifecycle !== undefined
      ? { update_type: "lifecycle_transition", lifecycle }
      : normalizedPhase !== undefined
        ? { update_type: "phase_transition", phase: normalizedPhase }
        : { update_type: "work_package_status", package_id: statusPackageId, status: workPackageStatus, ...(details.reason ? { reason: details.reason.trim() } : {}) };
    return this.#mutate({
      campaignId: id,
      expectedVersion,
      actor,
      eventType: "campaign_update",
      payload,
      callback: (connection, campaign, changedAt) => {
        if (lifecycle && lifecycle !== campaign.lifecycle && !(LIFECYCLE_TRANSITIONS[campaign.lifecycle] || []).includes(lifecycle)) {
          throw new CampaignError("INVALID_TRANSITION", `Cannot transition ${campaign.lifecycle} to ${lifecycle}`, {
            campaign_id: id,
            from: campaign.lifecycle,
            to: lifecycle,
            allowed: LIFECYCLE_TRANSITIONS[campaign.lifecycle] || [],
            mutated: false,
          });
        }
        if (lifecycle) connection.exec("UPDATE campaign SET lifecycle = ?, updated_at = ? WHERE campaign_id = ?", [lifecycle, changedAt, id]);
        if (normalizedPhase !== undefined) {
          const charter = { ...campaign.charter, current_phase: normalizedPhase };
          connection.exec("UPDATE campaign SET charter_json = ?, updated_at = ? WHERE campaign_id = ?", [json(charter), changedAt, id]);
        }
        if (workPackageStatus !== null) {
          const packageId = statusPackageId;
          const result = connection.exec("UPDATE work_package SET status = ?, updated_at = ? WHERE package_id = ? AND campaign_id = ?", [workPackageStatus, changedAt, packageId, id]);
          if (result?.changes === 0) throw new CampaignError("WORK_PACKAGE_NOT_FOUND", `Work package not found: ${packageId}`, { work_package_id: packageId, mutated: false });
        }
      },
    });
  }

  finish({ campaign_id: campaignId, expected_version: expectedVersion, actor, run_id: runId = null, closeout = {}, closure_kind: closureKindInput = null }) {
    const id = requireCampaignId(campaignId);
    requireObject(closeout, "closeout");
    const campaign = this.#requireCampaign(id);
    const run = runId ? requireId(runId, "run_id") : this.binding?.campaign_id === id ? this.binding.run_id : null;
    if (!run) throw new CampaignError("CAMPAIGN_NOT_BOUND", "A bound run is required to finish a campaign", { campaign_id: id, mutated: false });
    this.#requireRun(id, run);
    const finalInventory = closeout.final_inventory ?? closeout.final_inventory_ids ?? [];
    if (!Array.isArray(finalInventory) || finalInventory.length === 0) invalid("closeout.final_inventory", "closeout.final_inventory must contain at least one entry", "non-empty array", finalInventory);
    const closureKind = String(closureKindInput ?? closeout.closure_kind ?? "FULL").toUpperCase();
    if (!["FULL", "QUALIFIED"].includes(closureKind)) invalid("closure_kind", "closure_kind must be FULL or QUALIFIED", ["FULL", "QUALIFIED"], closureKind);
    const limitations = closeout.limitations ?? [];
    if (!Array.isArray(limitations) || limitations.some((item) => typeof item !== "string" || item.trim() === "")) {
      invalid("closeout.limitations", "closeout.limitations must be an array of non-empty strings", "string array", limitations);
    }
    const target = closureKind === "QUALIFIED" ? "CLOSED_QUALIFIED" : "CLOSED";
    if (campaign.lifecycle !== "CLOSING" || !(LIFECYCLE_TRANSITIONS[campaign.lifecycle] || []).includes(target)) {
      throw new CampaignError("INVALID_TRANSITION", `Cannot finish campaign from ${campaign.lifecycle}`, { campaign_id: id, lifecycle: campaign.lifecycle, required: ["CLOSING"], mutated: false });
    }
    return this.#mutate({
      campaignId: id,
      expectedVersion,
      actor,
      eventType: "campaign_close",
      payload: { closure_kind: closureKind, limitations },
      callback: (connection, _campaign, changedAt) => {
        const closeProblems = workPackageCloseProblems(connection, id);
        if (closureKind === "FULL") {
          if (closeProblems.length > 0) {
            throw new CampaignError("CAMPAIGN_WORK_PACKAGES_UNRESOLVED", "FULL close requires every work package to be reconciled with evidence or explicitly disposed", {
              campaign_id: id,
              unresolved_work_packages: closeProblems,
              mutated: false,
            });
          }
        } else if (closeProblems.length > 0) {
          const missing = closeProblems.filter((row) => !limitations.some((limitation) => limitationNamesPackageId(limitation, row.package_id)));
          if (limitations.length === 0 || missing.length > 0) {
            throw new CampaignError("CAMPAIGN_LIMITATIONS_REQUIRED", "Qualified close must name each unresolved work package in its limitations", {
              campaign_id: id,
              unresolved_work_packages: closeProblems,
              limitations_required_for: missing.map((row) => row.package_id),
              mutated: false,
            });
          }
        }
        connection.exec("UPDATE campaign SET lifecycle = ?, updated_at = ? WHERE campaign_id = ?", [target, changedAt, id]);
        connection.exec(
          "INSERT INTO artifact(artifact_id, campaign_id, package_id, identity, path_or_uri, hash, lifecycle, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [
            `${id}:closeout:${randomUUID()}`,
            id,
            null,
            `campaign-closeout:${id}`,
            `campaign://${id}/closeout`,
            `sha256:${digest({ campaign_id: id, closure_kind: closureKind, closeout })}`,
            "VERIFIED",
            json({ closure_kind: closureKind, limitations, closeout, final_inventory: finalInventory, run_id: run }),
            changedAt,
            changedAt,
          ],
        );
      },
    });
  }

  abandon({ campaign_id: campaignId, expected_version: expectedVersion, actor, run_id: runId = null, reason, details = {}, limitations = [] }) {
    const id = requireCampaignId(campaignId);
    const campaign = this.#requireCampaign(id);
    if (TERMINAL_LIFECYCLES.has(campaign.lifecycle)) throw new CampaignError("CAMPAIGN_TERMINAL", "A terminal campaign cannot be abandoned", { campaign_id: id, lifecycle: campaign.lifecycle, mutated: false });
    const run = runId ? requireId(runId, "run_id") : this.binding?.campaign_id === id ? this.binding.run_id : null;
    if (!run) throw new CampaignError("CAMPAIGN_NOT_BOUND", "A bound run is required to abandon a campaign", { campaign_id: id, mutated: false });
    this.#requireRun(id, run);
    const reasonValue = typeof reason === "string" ? requireString(reason, "reason") : requireObject(reason, "reason");
    requireObject(details, "details");
    if (!Array.isArray(limitations)) invalid("limitations", "limitations must be an array", "array", limitations);
    return this.#mutate({
      campaignId: id,
      expectedVersion,
      actor,
      eventType: "campaign_update",
      payload: { update_type: "lifecycle_transition", lifecycle: "ABORTED" },
      callback: (connection, _campaign, changedAt) => {
        connection.exec("UPDATE campaign SET lifecycle = ?, updated_at = ? WHERE campaign_id = ?", ["ABORTED", changedAt, id]);
        connection.exec(
          "INSERT INTO artifact(artifact_id, campaign_id, package_id, identity, path_or_uri, hash, lifecycle, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [
            `${id}:abandonment:${randomUUID()}`,
            id,
            null,
            `campaign-abandonment:${id}`,
            `campaign://${id}/abandonment`,
            `sha256:${digest({ campaign_id: id, reason: reasonValue, details, limitations })}`,
            "VERIFIED",
            json({ reason: reasonValue, details, limitations, run_id: run }),
            changedAt,
            changedAt,
          ],
        );
      },
    });
  }

  /** Compatibility alias. The OMO state is still updated by finish(). */
  close({ campaign_id: campaignId, expected_version: expectedVersion, actor, run_id: runId, closeout }) {
    return this.finish({ campaign_id: campaignId, expected_version: expectedVersion, actor, run_id: runId, closeout });
  }
}

export function createStore(options = {}) {
  return new CampaignStore(options);
}
