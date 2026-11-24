import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { getMeta, installSyncWith, setMeta } from "../install";
import { openTestDatabase } from "../testing/testDatabase";
import { addFolder, addNote, CONFIG, dirty, editNote, note, openDevice, SCHEMA } from "./fixtures";

describe("installSync", () => {
  test("creates the sync tables and is safe to run on every start", async () => {
    const { db } = await openDevice();
    await installSyncWith(db, CONFIG, "device-a");
    const tables = await db.getAllAsync<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '\\_sync%' ESCAPE '\\' ORDER BY name");
    expect(tables.map((t) => t.name)).toEqual(["_sync_changes", "_sync_meta", "_sync_rows"]);
  });

  test("refuses a table without the columns sync needs", async () => {
    const db = openTestDatabase();
    await db.execAsync(SCHEMA + "CREATE TABLE plain (id TEXT PRIMARY KEY, name TEXT);");
    await expect(installSyncWith(db, { ...CONFIG, tables: [{ name: "plain" }] }, "d")).rejects.toThrow("no column updated_at");
    await expect(installSyncWith(db, { ...CONFIG, tables: [{ name: "missing" }] }, "d")).rejects.toThrow("does not exist");
  });

  test("refuses to run with recursive triggers on", async () => {
    const db = openTestDatabase();
    await db.execAsync(SCHEMA + "PRAGMA recursive_triggers = ON;");
    await expect(installSyncWith(db, CONFIG, "d")).rejects.toThrow("recursive_triggers");
  });
});

describe("triggers", () => {
  test("mark inserts and updates dirty", async () => {
    const { db } = await openDevice();
    await addFolder(db, "f1", "folder", 10);
    await addNote(db, "n1", "hello", 10);
    expect(await dirty(db)).toEqual(["folders/f1", "notes/n1"]);
    await db.execAsync("DELETE FROM _sync_changes");
    await editNote(db, "n1", "edited", 20);
    expect(await dirty(db)).toEqual(["notes/n1"]);
  });

  test("leave seeded rows (stamp 0) out until they are changed", async () => {
    const { db } = await openDevice();
    await addFolder(db, "f1", "seed", 0);
    expect(await dirty(db)).toEqual([]);
    await db.runAsync("UPDATE folders SET name = 'mine', updated_at = 30 WHERE id = 'f1'");
    expect(await dirty(db)).toEqual(["folders/f1"]);
  });

  test("skip excluded keys", async () => {
    const { db } = await openDevice();
    await db.runAsync("INSERT INTO settings (key, value, updated_at) VALUES ('pro', '1', 5), ('theme', 'dark', 5)");
    await db.runAsync("UPDATE settings SET value = '0', updated_at = 6 WHERE key = 'pro'");
    expect(await dirty(db)).toEqual(["settings/theme"]);
  });

  test("record nothing while remote rows are applied", async () => {
    const { db } = await openDevice();
    await setMeta(db, "applying", "1");
    await addFolder(db, "f1", "remote", 10);
    await db.runAsync("UPDATE folders SET name = 'remote 2', updated_at = 5 WHERE id = 'f1'");
    await db.runAsync("DELETE FROM folders WHERE id = 'f1'");
    expect(await dirty(db)).toEqual([]);
  });

  test("move a stale stamp forward", async () => {
    const { db } = await openDevice();
    await addFolder(db, "f1", "folder", 1);
    await addNote(db, "n1", "fast clock", 5_000);
    // A device with a slow clock edits the row, or a write forgets to bump the stamp.
    await editNote(db, "n1", "slow clock", 4_000);
    expect((await note(db, "n1"))?.updated_at).toBe(5_001);
    await db.runAsync("UPDATE notes SET body = 'no stamp' WHERE id = 'n1'");
    expect((await note(db, "n1"))?.updated_at).toBe(5_002);
    // A forward stamp is left alone.
    await editNote(db, "n1", "later", 9_000);
    expect((await note(db, "n1"))?.updated_at).toBe(9_000);
  });

  test("refuse a hard delete on a table with tombstones, allow it on one without", async () => {
    const { db } = await openDevice();
    await addFolder(db, "f1", "folder", 1);
    await expect(db.runAsync("DELETE FROM folders WHERE id = 'f1'")).rejects.toThrow("hard delete on a synced table");
    await db.runAsync("INSERT INTO settings (key, value, updated_at) VALUES ('theme', 'dark', 5)");
    await db.runAsync("DELETE FROM settings WHERE key = 'theme'");
  });

  test("follow config changes on the next start", async () => {
    const { db } = await openDevice();
    await installSyncWith(db, { ...CONFIG, tables: [{ name: "folders" }] }, "device-a");
    await addFolder(db, "f1", "folder", 1);
    await addNote(db, "n1", "not synced now", 1);
    await db.runAsync("DELETE FROM notes WHERE id = 'n1'");
    expect(await dirty(db)).toEqual(["folders/f1"]);
  });
});

describe("restore detection", () => {
  test("a database from another install starts a first sync", async () => {
    const file = new Database(":memory:");
    const db = openTestDatabase(file);
    await db.execAsync(SCHEMA);
    await installSyncWith(db, CONFIG, "phone-1");
    await addFolder(db, "f1", "folder", 10);
    await addFolder(db, "seed", "seed", 0);
    await setMeta(db, "cursor", "0:7");
    await db.runAsync("INSERT INTO _sync_rows (table_name, row_id, sys) VALUES ('folders', 'f1', 'tag')");
    await db.execAsync("DELETE FROM _sync_changes");

    // Same install, next launch: nothing changes.
    await installSyncWith(db, CONFIG, "phone-1");
    expect(await getMeta(db, "cursor")).toBe("0:7");
    expect(await dirty(db)).toEqual([]);

    // The same file opened on a restored phone, whose no-backup id is new.
    await installSyncWith(db, CONFIG, "phone-2");
    expect(await getMeta(db, "device_id")).toBe("phone-2");
    expect(await getMeta(db, "cursor")).toBeNull();
    expect(await db.getAllAsync("SELECT * FROM _sync_rows")).toEqual([]);
    expect(await dirty(db)).toEqual(["folders/f1"]);
  });
});
