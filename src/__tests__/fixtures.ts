import { Database } from "bun:sqlite";
import type { SQLiteDatabase } from "expo-sqlite";

import { runCycle } from "../cycle";
import { installSyncWith } from "../install";
import { memoryTransport, type MemoryCloud } from "../testing/memoryTransport";
import { openTestDatabase } from "../testing/testDatabase";
import type { SyncConfig } from "../types";

export const SCHEMA = `
  PRAGMA foreign_keys = ON;
  CREATE TABLE settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE folders (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER);
  CREATE TABLE notes (
    id TEXT PRIMARY KEY NOT NULL,
    folder_id TEXT NOT NULL REFERENCES folders (id),
    body TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  );
`;

export const CONFIG: SyncConfig = {
  app: "test",
  schemaVersion: 1,
  tables: [{ name: "settings", key: "key", tombstone: null, excludeKeys: ["pro"] }, { name: "folders" }, { name: "notes" }],
};

export async function openDevice(deviceId = "device-a", config = CONFIG) {
  const file = new Database(":memory:");
  const db = openTestDatabase(file);
  await db.execAsync(SCHEMA);
  await installSyncWith(db, config, deviceId);
  return { db, file, deviceId };
}

export type Device = Awaited<ReturnType<typeof openDevice>>;

export const dirty = async (db: SQLiteDatabase) =>
  (await db.getAllAsync<{ table_name: string; row_id: string }>("SELECT table_name, row_id FROM _sync_changes ORDER BY table_name, row_id")).map(
    (row) => `${row.table_name}/${row.row_id}`,
  );

export const addFolder = (db: SQLiteDatabase, id: string, name: string, at: number) =>
  db.runAsync("INSERT INTO folders (id, name, updated_at) VALUES (?, ?, ?)", id, name, at);

export const addNote = (db: SQLiteDatabase, id: string, body: string, at: number, folder = "f1") =>
  db.runAsync("INSERT INTO notes (id, folder_id, body, updated_at) VALUES (?, ?, ?, ?)", id, folder, body, at);

export const editNote = (db: SQLiteDatabase, id: string, body: string, at: number) =>
  db.runAsync("UPDATE notes SET body = ?, updated_at = ? WHERE id = ?", body, at, id);

export const note = (db: SQLiteDatabase, id: string) =>
  db.getFirstAsync<{ id: string; body: string; updated_at: number; deleted_at: number | null }>("SELECT * FROM notes WHERE id = ?", id);

export const sync = (device: Device, cloud: MemoryCloud, options?: Parameters<typeof runCycle>[3], config = CONFIG) =>
  runCycle(device.db, config, memoryTransport(cloud), options);
