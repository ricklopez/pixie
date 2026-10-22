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
  account_id: string;
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
  created_at TEXT NOT NULL);
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
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, automation_id TEXT NOT NULL, revision INTEGER NOT NULL,
  account_id TEXT NOT NULL, caller_id TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL, input TEXT NOT NULL,
  idempotency_key TEXT, request_hash TEXT, result TEXT, failure TEXT, metrics TEXT,
  created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS runs_idempotency ON runs (caller_id, account_id, automation_id, revision, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS run_events (
  run_id TEXT NOT NULL REFERENCES runs(id), seq INTEGER NOT NULL, at TEXT NOT NULL, event TEXT NOT NULL, PRIMARY KEY (run_id, seq));
CREATE TABLE IF NOT EXISTS evidence (
  run_id TEXT NOT NULL REFERENCES runs(id), name TEXT NOT NULL, path TEXT NOT NULL, content_type TEXT NOT NULL, PRIMARY KEY (run_id, name));
`;

export function openDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  return db;
}

export const now = () => new Date().toISOString();
