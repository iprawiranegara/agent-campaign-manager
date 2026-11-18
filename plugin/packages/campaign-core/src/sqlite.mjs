import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

export const SCHEMA_VERSION = 1;
export const SCHEMA_CHECKSUM = "omo-research-campaign-schema-v1-fix1";

export const REQUIRED_TABLES = Object.freeze([
  "campaign",
  "scope_root",
  "authority_source",
  "deliverable",
  "work_package",
  "gate",
  "decision",
  "risk_issue",
  "receipt",
  "artifact",
  "file_event",
  "run_record",
  "evidence_claim",
  "event",
]);

export const REQUIRED_SCHEMA_TABLES = Object.freeze(["schema_migration", ...REQUIRED_TABLES]);

const campaignLifecycle = [
  "DRAFT",
  "ORIENTING",
  "READY",
  "EXECUTING",
  "VERIFYING",
  "CLOSING",
  "CLOSED",
  "WAITING_OWNER",
  "BLOCKED",
  "PAUSED",
  "FAILED",
  "ABORTED",
  "CLOSED_QUALIFIED",
].map((value) => `'${value}'`).join(", ");

const workPackageStatus = [
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
].map((value) => `'${value}'`).join(", ");

const runStatus = [
  "PLANNED",
  "RUNNING",
  "PAUSED",
  "WAITING_RESOURCE",
  "WAITING_OWNER",
  "VERIFYING",
  "ACCEPTED",
  "FAILED",
  "CANCELLED",
  "SUPERSEDED",
].map((value) => `'${value}'`).join(", ");

/** The OMO schema is duplicated deliberately: OMO and Codex share state, not executable source. */
export const SCHEMA_V1_SQL = `
CREATE TABLE IF NOT EXISTS schema_migration (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL,
  checksum TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campaign (
  campaign_id TEXT PRIMARY KEY,
  objective TEXT NOT NULL,
  charter_json TEXT NOT NULL CHECK (json_valid(charter_json)),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN (${campaignLifecycle})),
  accountable_primary TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scope_root (
  scope_root_id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaign(campaign_id),
  path TEXT NOT NULL,
  attribution_class TEXT NOT NULL DEFAULT 'PRIMARY_DIRECT',
  created_at TEXT NOT NULL,
  UNIQUE(campaign_id, path)
);

CREATE TABLE IF NOT EXISTS authority_source (
  authority_source_id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaign(campaign_id),
  path TEXT NOT NULL,
  authority_class TEXT NOT NULL,
  precedence INTEGER NOT NULL CHECK (precedence >= 0),
  modified_at TEXT NOT NULL,
  hash TEXT NOT NULL,
  freshness_json TEXT NOT NULL CHECK (json_valid(freshness_json)),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deliverable (
  deliverable_id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaign(campaign_id),
  title TEXT NOT NULL,
  acceptance_rule TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PROPOSED', 'ACCEPTED', 'REJECTED', 'SUPERSEDED')),
  details_json TEXT NOT NULL CHECK (json_valid(details_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS work_package (
  package_id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaign(campaign_id),
  status TEXT NOT NULL CHECK (status IN (${workPackageStatus})),
  objective TEXT NOT NULL,
  dependencies_json TEXT NOT NULL CHECK (json_valid(dependencies_json)),
  contract_json TEXT NOT NULL CHECK (json_valid(contract_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gate (
  gate_id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaign(campaign_id),
  gate_class TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('OPEN', 'RESOLVED', 'WAIVED', 'REJECTED')),
  authority TEXT NOT NULL,
  resolution_json TEXT NOT NULL CHECK (json_valid(resolution_json)),
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS decision (
  decision_id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaign(campaign_id),
  status TEXT NOT NULL CHECK (status IN ('PROPOSED', 'RATIFIED', 'REJECTED', 'SUPERSEDED')),
  basis TEXT NOT NULL,
  owner_status TEXT NOT NULL,
  affected_objects_json TEXT NOT NULL CHECK (json_valid(affected_objects_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS risk_issue (
  risk_issue_id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaign(campaign_id),
  title TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  owner TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('OPEN', 'MITIGATING', 'ACCEPTED', 'RESOLVED')),
  disposition TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS receipt (
  receipt_id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaign(campaign_id),
  package_id TEXT REFERENCES work_package(package_id),
  status TEXT NOT NULL CHECK (status IN ('COMPLETED', 'PARTIAL', 'BLOCKED', 'FAILED')),
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artifact (
  artifact_id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaign(campaign_id),
  package_id TEXT REFERENCES work_package(package_id),
  identity TEXT NOT NULL,
  path_or_uri TEXT NOT NULL,
  hash TEXT NOT NULL,
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('DECLARED', 'PRODUCED', 'VERIFIED', 'REJECTED')),
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS file_event (
  file_event_id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaign(campaign_id),
  package_id TEXT REFERENCES work_package(package_id),
  path TEXT NOT NULL,
  event_kind TEXT NOT NULL CHECK (event_kind IN ('CREATED', 'MODIFIED', 'DELETED', 'INSPECTED', 'GENERATED')),
  attribution_class TEXT NOT NULL,
  hash_before TEXT,
  hash_after TEXT,
  recorded_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS run_record (
  run_id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaign(campaign_id),
  package_id TEXT NOT NULL REFERENCES work_package(package_id),
  runner_type TEXT NOT NULL,
  session_or_process_id TEXT NOT NULL,
  cwd TEXT NOT NULL,
  command_hash TEXT NOT NULL,
  environment_fingerprint TEXT NOT NULL,
  run_json TEXT NOT NULL CHECK (json_valid(run_json)),
  status TEXT NOT NULL CHECK (status IN (${runStatus})),
  started_at TEXT NOT NULL,
  last_observed_at TEXT NOT NULL,
  last_verified_checkpoint TEXT
);

CREATE TABLE IF NOT EXISTS evidence_claim (
  evidence_claim_id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaign(campaign_id),
  claim TEXT NOT NULL,
  evidence_state TEXT NOT NULL CHECK (evidence_state IN ('LEAD', 'IDENTITY_RESOLVED', 'FULL_TEXT_OR_PRIMARY_RECORD_ACQUIRED', 'REVIEWED', 'ACCEPTED_FOR_CLAIM', 'REJECTED')),
  support_json TEXT NOT NULL CHECK (json_valid(support_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS event (
  event_id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaign(campaign_id),
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  previous_version INTEGER NOT NULL CHECK (previous_version >= 0),
  new_version INTEGER NOT NULL CHECK (new_version = previous_version + 1),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  UNIQUE(campaign_id, new_version)
);

CREATE TRIGGER IF NOT EXISTS event_is_immutable_update
BEFORE UPDATE ON event
BEGIN
  SELECT RAISE(ABORT, 'EVENT_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS event_is_immutable_delete
BEFORE DELETE ON event
BEGIN
  SELECT RAISE(ABORT, 'EVENT_IMMUTABLE');
END;
`;

export class CampaignSqliteError extends Error {
  constructor(code, message = code, details = {}) {
    super(message === code || message.startsWith(`${code}:`) ? message : `${code}: ${message}`);
    this.name = "CampaignSqliteError";
    this.code = code;
    this.details = details;
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function ensureAbsolutePath(path) {
  if (typeof path !== "string" || path.trim() === "") {
    throw new CampaignSqliteError("CAMPAIGN_DATABASE_PATH_REQUIRED");
  }
  if (!isAbsolute(path)) {
    throw new CampaignSqliteError("CAMPAIGN_DATABASE_PATH_ABSOLUTE");
  }
  return resolve(path);
}

function protectFile(path) {
  try {
    if (existsSync(path)) chmodSync(path, 0o600);
  } catch {
    // Best effort on filesystems without POSIX permissions.
  }
}

function protectDirectory(path) {
  try {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
  } catch {
    // The open operation will surface a real access failure.
  }
}

function databaseState(path) {
  try {
    const state = statSync(path);
    if (!state.isFile()) {
      throw new CampaignSqliteError("CAMPAIGN_DATABASE_UNREADABLE", "Campaign database path is not a regular file", { path });
    }
    return state.size === 0 ? "empty" : "present";
  } catch (error) {
    if (error instanceof CampaignSqliteError) throw error;
    if (error?.code === "ENOENT") return "missing";
    throw new CampaignSqliteError("CAMPAIGN_DATABASE_UNREADABLE", "Campaign database cannot be inspected", {
      path,
      cause: errorMessage(error),
    });
  }
}

function normalizeBinding(value) {
  return typeof value === "boolean" ? (value ? 1 : 0) : value;
}

function normalizeBindings(bindings) {
  if (Array.isArray(bindings)) return bindings.map(normalizeBinding);
  if (bindings === null || typeof bindings !== "object" || bindings instanceof Uint8Array) {
    return [normalizeBinding(bindings)];
  }
  return Object.fromEntries(Object.entries(bindings).map(([key, value]) => [key, normalizeBinding(value)]));
}

function invoke(statement, method, bindings) {
  if (bindings === undefined) return statement[method]();
  const normalized = normalizeBindings(bindings);
  return Array.isArray(normalized) ? statement[method](...normalized) : statement[method](normalized);
}

export class SqliteDatabase {
  constructor(path, database) {
    this.path = path;
    this.#database = database;
  }

  static open({ path, dbPath, databasePath, allowCreate = false } = {}) {
    const normalizedPath = ensureAbsolutePath(path ?? dbPath ?? databasePath ?? "");
    const state = databaseState(normalizedPath);
    if (!allowCreate && state === "missing") {
      throw new CampaignSqliteError("CAMPAIGN_DATABASE_MISSING", "Canonical campaign database does not exist", { path: normalizedPath });
    }
    if (allowCreate) protectDirectory(dirname(normalizedPath));

    let database;
    try {
      database = new DatabaseSync(normalizedPath);
    } catch (error) {
      throw new CampaignSqliteError("CAMPAIGN_DATABASE_UNREADABLE", "Canonical campaign database cannot be opened", {
        path: normalizedPath,
        cause: errorMessage(error),
      });
    }

    const adapter = new SqliteDatabase(normalizedPath, database);
    try {
      const shouldCreateSchema = allowCreate && (state === "missing" || state === "empty");
      if (shouldCreateSchema) {
        adapter.exec("PRAGMA journal_mode = WAL");
        adapter.exec("PRAGMA synchronous = FULL");
        adapter.exec("PRAGMA foreign_keys = ON");
        adapter.exec("PRAGMA busy_timeout = 5000");
        adapter.transaction((connection) => {
          connection.exec(SCHEMA_V1_SQL);
          connection.exec(
            "INSERT OR IGNORE INTO schema_migration (version, applied_at, checksum) VALUES (?, ?, ?)",
            [SCHEMA_VERSION, new Date().toISOString(), SCHEMA_CHECKSUM],
          );
        });
      } else {
        adapter.validateSchema();
        adapter.exec("PRAGMA journal_mode = WAL");
        adapter.exec("PRAGMA synchronous = FULL");
        adapter.exec("PRAGMA foreign_keys = ON");
        adapter.exec("PRAGMA busy_timeout = 5000");
      }
      adapter.#protectFiles();
      return adapter;
    } catch (error) {
      try {
        adapter.close();
      } catch {
        // Preserve the original schema/open error.
      }
      if (error instanceof CampaignSqliteError) throw error;
      throw new CampaignSqliteError("CAMPAIGN_DATABASE_INCOMPATIBLE", "Campaign database schema is incompatible", {
        path: normalizedPath,
        cause: errorMessage(error),
      });
    }
  }

  #database;
  #closed = false;
  #transactionDepth = 0;
  #savepointCounter = 0;

  #ensureOpen() {
    if (this.#closed) throw new CampaignSqliteError("CAMPAIGN_DATABASE_CLOSED");
  }

  #protectFiles() {
    protectFile(this.path);
    protectFile(`${this.path}-wal`);
    protectFile(`${this.path}-shm`);
  }

  exec(sql, bindings) {
    this.#ensureOpen();
    if (bindings === undefined) this.#database.exec(sql);
    else invoke(this.#database.prepare(sql), "run", bindings);
    this.#protectFiles();
  }

  query(sql, bindings) {
    this.#ensureOpen();
    const rows = invoke(this.#database.prepare(sql), "all", bindings);
    if (!Array.isArray(rows)) return [];
    return rows.map((row) => Object.fromEntries(Object.entries(row)));
  }

  transaction(callback) {
    this.#ensureOpen();
    const nested = this.#transactionDepth > 0;
    const savepoint = nested ? `omo_campaign_sp_${++this.#savepointCounter}` : null;
    if (nested) this.#database.exec(`SAVEPOINT ${savepoint}`);
    else this.#database.exec("BEGIN IMMEDIATE");
    this.#transactionDepth += 1;
    try {
      const value = callback(this);
      if (value && typeof value.then === "function") {
        throw new CampaignSqliteError("CAMPAIGN_SQLITE_ASYNC_TRANSACTION", "SQLite transactions must use synchronous callbacks");
      }
      this.#transactionDepth -= 1;
      if (nested) this.#database.exec(`RELEASE SAVEPOINT ${savepoint}`);
      else this.#database.exec("COMMIT");
      this.#protectFiles();
      return value;
    } catch (error) {
      this.#transactionDepth = Math.max(0, this.#transactionDepth - 1);
      try {
        if (nested) {
          this.#database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          this.#database.exec(`RELEASE SAVEPOINT ${savepoint}`);
        } else {
          this.#database.exec("ROLLBACK");
        }
      } catch {
        // Preserve the original failure.
      }
      this.#protectFiles();
      throw error;
    }
  }

  validateSchema() {
    this.#ensureOpen();
    let tables;
    try {
      tables = this.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((row) => row.name);
    } catch (error) {
      throw new CampaignSqliteError("CAMPAIGN_DATABASE_INCOMPATIBLE", "Campaign database schema cannot be read", {
        path: this.path,
        cause: errorMessage(error),
      });
    }

    for (const table of REQUIRED_SCHEMA_TABLES) {
      if (!tables.includes(table)) {
        throw new CampaignSqliteError("SCHEMA_TABLE_MISSING", `Required campaign table is missing: ${table}`, { table });
      }
    }

    const migration = this.query("SELECT version, checksum FROM schema_migration WHERE version = ?", [SCHEMA_VERSION])[0];
    if (!migration) {
      const maximum = this.query("SELECT MAX(version) AS version FROM schema_migration")[0]?.version;
      if (maximum !== null && maximum !== undefined && maximum > SCHEMA_VERSION) {
        throw new CampaignSqliteError("SCHEMA_VERSION_UNSUPPORTED", "Campaign database schema is newer than this adapter", {
          expected: SCHEMA_VERSION,
          actual: maximum,
        });
      }
      throw new CampaignSqliteError("SCHEMA_VERSION_MISSING", "Campaign schema migration version is missing", {
        expected: SCHEMA_VERSION,
      });
    }
    if (migration.checksum !== SCHEMA_CHECKSUM) {
      throw new CampaignSqliteError("SCHEMA_CHECKSUM_MISMATCH", "Campaign schema checksum does not match", {
        expected: SCHEMA_CHECKSUM,
        actual: migration.checksum,
      });
    }

    const maximum = this.query("SELECT MAX(version) AS version FROM schema_migration")[0]?.version;
    if (maximum !== null && maximum !== undefined && maximum > SCHEMA_VERSION) {
      throw new CampaignSqliteError("SCHEMA_VERSION_UNSUPPORTED", "Campaign database schema is newer than this adapter", {
        expected: SCHEMA_VERSION,
        actual: maximum,
      });
    }
    return { version: SCHEMA_VERSION, checksum: SCHEMA_CHECKSUM, tables };
  }

  close() {
    if (this.#closed) return;
    try {
      this.#database.close();
    } finally {
      this.#closed = true;
      this.#protectFiles();
    }
  }
}

export function openSqlite(pathOrOptions, options = {}) {
  const normalized = typeof pathOrOptions === "string" ? { path: pathOrOptions, ...options } : pathOrOptions;
  return SqliteDatabase.open(normalized);
}

export const openCampaignDatabase = openSqlite;
export const openCampaignSqlite = openSqlite;
export const openSqliteDatabase = openSqlite;
export const createSqlite = openSqlite;
export const createSqliteAdapter = openSqlite;
export const CampaignSqliteAdapter = SqliteDatabase;
export const SqliteAdapter = SqliteDatabase;
