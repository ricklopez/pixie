import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type RunState = "queued" | "running" | "verifying" | "completed" | "needs_review" | "awaiting_auth" | "failed" | "cancelled";
export type AutomationState = "draft" | "recording" | "configuring" | "testing" | "ready" | "published";

export interface AutomationRow {
  id: string;
  tenant_id: string;
  name: string;
  state: AutomationState;
  definition: string;
  recording_id: string | null;
  last_test_run_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface RevisionRow {
  automation_id: string;
  revision: number;
  checksum: string;
  definition: string;
  published_at: string;
  published_by: string;
  test_run_id: string | null;
}

export interface RunRow {
  id: string;
  tenant_id: string;
  automation_id: string;
  revision: number;
  operation_version_id: string | null;
  adapter_revision_id: string | null;
  account_id: string;
  connection_id: string | null;
  caller_id: string;
  kind: "test" | "endpoint";
  state: RunState;
  input: string;
  idempotency_key: string | null;
  request_hash: string | null;
  result: string | null;
  failure: string | null;
  metrics: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tenants (id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE, role TEXT NOT NULL CHECK (role IN ('developer','client')), created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), name TEXT NOT NULL, portal_origin TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'local' CHECK (provider IN ('local','browserbase')),
  environment TEXT NOT NULL DEFAULT 'local', auth_required_signals TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), environment TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('local','browserbase')), context_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('disconnected','connecting','connected','auth_required')),
  context_status TEXT NOT NULL DEFAULT 'active', controller_key_id TEXT, last_verified_at TEXT,
  last_session_seconds INTEGER NOT NULL DEFAULT 0, UNIQUE (account_id, environment));
CREATE TABLE IF NOT EXISTS browser_session_ledger (
  id TEXT PRIMARY KEY, run_id TEXT REFERENCES runs(id), connection_id TEXT REFERENCES connections(id),
  purpose TEXT NOT NULL, at TEXT NOT NULL, session_seconds INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS account_secrets (
  account_id TEXT NOT NULL REFERENCES accounts(id), ref TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (account_id, ref));
CREATE TABLE IF NOT EXISTS automations (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), name TEXT NOT NULL, state TEXT NOT NULL,
  definition TEXT NOT NULL, recording_id TEXT, last_test_run_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS recordings (
  id TEXT PRIMARY KEY, automation_id TEXT NOT NULL REFERENCES automations(id), started_at TEXT NOT NULL, stopped_at TEXT,
  events TEXT NOT NULL, warnings TEXT NOT NULL, action_count INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS revisions (
  automation_id TEXT NOT NULL REFERENCES automations(id), revision INTEGER NOT NULL, checksum TEXT NOT NULL,
  definition TEXT NOT NULL, published_at TEXT NOT NULL, published_by TEXT NOT NULL, test_run_id TEXT,
  PRIMARY KEY (automation_id, revision));
CREATE TABLE IF NOT EXISTS model_versions (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), name TEXT NOT NULL,
  major INTEGER NOT NULL, minor INTEGER NOT NULL, schema_json TEXT NOT NULL, identity_fields TEXT NOT NULL, hash TEXT NOT NULL,
  UNIQUE (tenant_id, name, major, minor));
CREATE TABLE IF NOT EXISTS repositories (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), name TEXT NOT NULL,
  UNIQUE (tenant_id, name));
CREATE TABLE IF NOT EXISTS operation_versions (
  id TEXT PRIMARY KEY, repository_id TEXT NOT NULL REFERENCES repositories(id), method TEXT NOT NULL,
  major INTEGER NOT NULL, minor INTEGER NOT NULL, input_schema TEXT NOT NULL,
  model_version_id TEXT NOT NULL REFERENCES model_versions(id), effect TEXT NOT NULL CHECK (effect IN ('read','write')),
  checks TEXT NOT NULL, allowed_origins TEXT NOT NULL, connection_requirement TEXT NOT NULL,
  limits TEXT NOT NULL, hash TEXT NOT NULL, UNIQUE (repository_id, method, major, minor));
CREATE TABLE IF NOT EXISTS adapter_revisions (
  id TEXT PRIMARY KEY, operation_version_id TEXT NOT NULL REFERENCES operation_versions(id), revision INTEGER NOT NULL,
  definition_hash TEXT NOT NULL, engine TEXT NOT NULL, engine_revision TEXT NOT NULL,
  generator TEXT NOT NULL CHECK (generator IN ('template','recorded','manual')),
  source TEXT,
  automation_id TEXT NOT NULL REFERENCES automations(id), automation_revision INTEGER NOT NULL,
  hash TEXT NOT NULL, UNIQUE (operation_version_id, revision));
CREATE TABLE IF NOT EXISTS publication_bindings (
  repository_id TEXT NOT NULL REFERENCES repositories(id), method TEXT NOT NULL, major INTEGER NOT NULL,
  operation_version_id TEXT NOT NULL REFERENCES operation_versions(id),
  adapter_revision_id TEXT NOT NULL REFERENCES adapter_revisions(id),
  PRIMARY KEY (repository_id, method, major));
CREATE TABLE IF NOT EXISTS retired_operations (
  operation_version_id TEXT PRIMARY KEY REFERENCES operation_versions(id),
  retired_at TEXT NOT NULL, retired_by TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS model_versions_no_update BEFORE UPDATE ON model_versions
BEGIN SELECT RAISE(ABORT, 'published rows are immutable'); END;
CREATE TRIGGER IF NOT EXISTS model_versions_no_delete BEFORE DELETE ON model_versions
BEGIN SELECT RAISE(ABORT, 'published rows are immutable'); END;
CREATE TRIGGER IF NOT EXISTS operation_versions_no_update BEFORE UPDATE ON operation_versions
BEGIN SELECT RAISE(ABORT, 'published rows are immutable'); END;
CREATE TRIGGER IF NOT EXISTS operation_versions_no_delete BEFORE DELETE ON operation_versions
BEGIN SELECT RAISE(ABORT, 'published rows are immutable'); END;
CREATE TRIGGER IF NOT EXISTS adapter_revisions_no_update BEFORE UPDATE ON adapter_revisions
BEGIN SELECT RAISE(ABORT, 'published rows are immutable'); END;
CREATE TRIGGER IF NOT EXISTS adapter_revisions_no_delete BEFORE DELETE ON adapter_revisions
BEGIN SELECT RAISE(ABORT, 'published rows are immutable'); END;
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, automation_id TEXT NOT NULL, revision INTEGER NOT NULL,
  operation_version_id TEXT REFERENCES operation_versions(id), adapter_revision_id TEXT REFERENCES adapter_revisions(id),
  account_id TEXT NOT NULL, connection_id TEXT, caller_id TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL, input TEXT NOT NULL,
  idempotency_key TEXT, request_hash TEXT, result TEXT, failure TEXT, metrics TEXT,
  created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS runs_idempotency ON runs (caller_id, account_id, automation_id, revision, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS run_events (
  run_id TEXT NOT NULL REFERENCES runs(id), seq INTEGER NOT NULL, at TEXT NOT NULL, event TEXT NOT NULL, PRIMARY KEY (run_id, seq));
CREATE TABLE IF NOT EXISTS evidence (
  run_id TEXT NOT NULL REFERENCES runs(id), name TEXT NOT NULL, path TEXT NOT NULL, content_type TEXT NOT NULL, PRIMARY KEY (run_id, name));
CREATE TABLE IF NOT EXISTS spend_ledger (
  run_id TEXT PRIMARY KEY REFERENCES runs(id), at TEXT NOT NULL, provider_calls INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL, estimated_cost_usd REAL NOT NULL, browser_session_seconds INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS repair_candidates (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, automation_id TEXT NOT NULL, run_id TEXT NOT NULL,
  source TEXT NOT NULL, source_hash TEXT NOT NULL, generator TEXT NOT NULL CHECK (generator IN ('manual','model')),
  state TEXT NOT NULL CHECK (state IN ('validating','awaiting_approval','approved','rejected')),
  validation TEXT NOT NULL, rejection_reason TEXT, created_at TEXT NOT NULL, approved_at TEXT);
`;

export function openDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  ensureColumn(db, "accounts", "provider", "TEXT NOT NULL DEFAULT 'local'");
  ensureColumn(db, "accounts", "environment", "TEXT NOT NULL DEFAULT 'local'");
  ensureColumn(db, "accounts", "auth_required_signals", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "runs", "connection_id", "TEXT");
  ensureColumn(db, "runs", "operation_version_id", "TEXT");
  ensureColumn(db, "runs", "adapter_revision_id", "TEXT");
  ensureColumn(db, "spend_ledger", "browser_session_seconds", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "adapter_revisions", "source", "TEXT");
  return db;
}

function ensureColumn(db: DatabaseSync, table: string, column: string, declaration: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((item) => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
}

export const now = () => new Date().toISOString();
