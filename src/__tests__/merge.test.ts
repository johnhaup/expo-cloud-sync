import { describe, expect, test } from "bun:test";

import { getMeta } from "../install";
import { decide, payloadOf } from "../merge";
import { createMemoryCloud } from "../testing/memoryTransport";
import { addFolder, addNote, CONFIG, dirty, note, openDevice, sync } from "./fixtures";

const record = (updatedAt: number, payload: string) => ({ updatedAt, payload });

describe("decide", () => {
  test("rule 1: no local row applies", () => {
    expect(decide(undefined, record(1, "{}"))).toBe("apply");
  });

  test("rule 2: the newer stamp wins", () => {
    expect(decide(record(1, '{"a":1}'), record(2, '{"a":2}'))).toBe("apply");
    expect(decide(record(3, '{"a":1}'), record(2, '{"a":2}'))).toBe("keep");
  });

  test("rule 3: equal stamps, equal payload is the same, else the greater payload wins on both sides", () => {
    expect(decide(record(5, '{"a":1}'), record(5, '{"a":1}'))).toBe("same");
    const low = record(5, '{"a":1}');
    const high = record(5, '{"a":2}');
    expect(decide(low, high)).toBe("apply");
    expect(decide(high, low)).toBe("keep");
  });

  test("rule 4: the whole record wins (no field merge)", () => {
    // The decision is one verdict per record; applying writes every column of the winner (see below).
    expect(decide(record(1, '{"a":1,"b":1}'), record(2, '{"a":2}'))).toBe("apply");
  });

  test("a new install before its first download: the remote record wins even when older", () => {
    expect(decide(record(50, '{"a":1}'), record(10, '{"a":2}'), true)).toBe("apply");
    expect(decide(record(10, '{"a":1}'), record(10, '{"a":1}'), true)).toBe("same");
    expect(decide(undefined, record(1, "{}"), true)).toBe("apply");
  });

  test("payloads are independent of column order", () => {
    expect(payloadOf({ b: 1, a: "x", c: null })).toBe(payloadOf({ c: null, a: "x", b: 1 }));
    expect(payloadOf({ b: 1, a: "x" })).toBe('{"a":"x","b":1}');
  });
});

describe("applying records", () => {
  test("rule 2: a kept local row is pushed even if it was not dirty", async () => {
    const device = await openDevice();
    await addFolder(device.db, "f1", "mine", 50);
    await device.db.execAsync("DELETE FROM _sync_changes");
    const cloud = createMemoryCloud();
    cloud.put({ table: "folders", id: "f1", updatedAt: 10, schemaVersion: 1, payload: payloadOf({ id: "f1", name: "old", updated_at: 10, deleted_at: null }) });
    await sync(device, cloud);
    expect(cloud.records().find((r) => r.id === "f1")?.payload).toContain('"mine"');
    expect(await dirty(device.db)).toEqual([]);
  });

  test("rule 4: the winner's columns replace every local column", async () => {
    const device = await openDevice();
    await addFolder(device.db, "f1", "folder", 1);
    await addNote(device.db, "n1", "local", 1);
    const cloud = createMemoryCloud();
    cloud.put({
      table: "notes",
      id: "n1",
      updatedAt: 9,
      schemaVersion: 1,
      payload: payloadOf({ id: "n1", folder_id: "f1", body: "remote", updated_at: 9, deleted_at: 9 }),
    });
    await sync(device, cloud);
    expect(await note(device.db, "n1")).toEqual({ id: "n1", folder_id: "f1", body: "remote", updated_at: 9, deleted_at: 9 } as never);
  });

  test("rule 5: only local columns are written; missing ones keep their value or take the default", async () => {
    const device = await openDevice();
    await addFolder(device.db, "f1", "folder", 1);
    await addNote(device.db, "n1", "kept", 1);
    const cloud = createMemoryCloud();
    // An older writer without `body`, and a column this device does not have.
    cloud.put({ table: "notes", id: "n1", updatedAt: 5, schemaVersion: 1, payload: payloadOf({ id: "n1", folder_id: "f1", updated_at: 5, deleted_at: null, color: "red" }) });
    cloud.put({ table: "notes", id: "n2", updatedAt: 5, schemaVersion: 1, payload: payloadOf({ id: "n2", folder_id: "f1", updated_at: 5, deleted_at: null, color: "red" }) });
    const result = await sync(device, cloud);
    expect(result.state).toBe("idle");
    expect((await note(device.db, "n1"))?.body).toBe("kept");
    expect((await note(device.db, "n1"))?.updated_at).toBe(5);
    expect((await note(device.db, "n2"))?.body).toBe("");
  });

  test("rule 6: a record from a newer schema stops the cycle before anything is applied", async () => {
    const device = await openDevice();
    await addFolder(device.db, "f1", "folder", 1);
    const cloud = createMemoryCloud();
    cloud.put({ table: "notes", id: "n1", updatedAt: 5, schemaVersion: 1, payload: payloadOf({ id: "n1", folder_id: "f1", body: "v1", updated_at: 5, deleted_at: null }) });
    cloud.put({ table: "notes", id: "n2", updatedAt: 5, schemaVersion: 2, payload: payloadOf({ id: "n2", folder_id: "f1", body: "v2", updated_at: 5, deleted_at: null }) });
    const result = await sync(device, cloud);
    expect(result.state).toBe("needsAppUpdate");
    expect(await note(device.db, "n1")).toBeNull();
    expect(await getMeta(device.db, "cursor")).toBeNull();
    // Nothing pushed: the local folder is still only here.
    expect(cloud.records().some((r) => r.table === "folders")).toBe(false);
    // The hold stays until the app is updated…
    expect((await sync(device, cloud)).state).toBe("needsAppUpdate");
    // …and a newer app clears it and syncs.
    const updated = { ...CONFIG, schemaVersion: 2 };
    expect((await sync(device, cloud, {}, updated)).state).toBe("idle");
    expect((await note(device.db, "n2"))?.body).toBe("v2");
  });
});
