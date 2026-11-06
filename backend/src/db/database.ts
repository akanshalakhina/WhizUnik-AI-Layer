import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from './schema';
import type { Db } from '../types';

/** Open the read-write connection (platform + AI bookkeeping tables) and create the schema. */
export function openWritableDb(file: string): Db {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  return db;
}

/**
 * Open a READ-ONLY connection. The AI data tools only ever receive this handle,
 * so even a bug in the AI layer cannot modify a financial or inventory record
 * (Phase 1 requirement: "AI must never directly modify important records").
 */
export function openReadOnlyDb(file: string): Db {
  if (file === ':memory:') {
    throw new Error('A read-only connection needs a database file; :memory: databases cannot be shared.');
  }
  const db = new Database(file, { readonly: true, fileMustExist: true });
  db.pragma('query_only = ON');
  return db;
}
