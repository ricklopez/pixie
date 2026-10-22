import { createRequire } from "node:module";

export interface SqliteStatement {
  all(...params: unknown[]): Record<string, unknown>[];
  get(...params: unknown[]): Record<string, unknown> | undefined;
  run(...params: unknown[]): unknown;
}

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

type DatabaseConstructor = new (path: string) => unknown;

const require = createRequire(import.meta.url);
let Database: DatabaseConstructor | undefined;

try {
  Database = (require("node:sqlite") as { DatabaseSync?: DatabaseConstructor }).DatabaseSync;
} catch {
  Database = undefined;
}

if (!Database) Database = require("better-sqlite3") as DatabaseConstructor;

export function openSqliteDatabase(path: string): SqliteDatabase {
  return new Database!(path) as SqliteDatabase;
}
