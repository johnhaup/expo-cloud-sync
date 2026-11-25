import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCloudSyncWith } from "../cloudSync";
import { runCycle } from "../cycle";
import { getMeta, installSyncWith, setMeta } from "../install";
import { payloadOf } from "../merge";
import { createMemoryCloud, memoryTransport, type MemoryCloud } from "../testing/memoryTransport";
import { openTestDatabase } from "../testing/testDatabase";
import type { Transport } from "../types";
import { addFolder, addNote, CONFIG, dirty, editNote, note, openDevice, SCHEMA, sync, type Device } from "./fixtures";

const notes = async (device: Device) =>
  (await device.db.getAllAsync<{ id: string; body: string; deleted_at: number | null }>("SELECT id, body, deleted_at FROM notes ORDER BY id")).map(
    (row) => `${row.id}:${row.body}${row.deleted_at ? " (deleted)" : ""}`,
  );

/** Two devices on one account, each with the shared folder f1 already synced. */
async function twoDevices() {
  const cloud = createMemoryCloud();
  const a = await openDevice("device-a");
  const b = await openDevice("device-b");
  await addFolder(a.db, "f1", "inbox", 1);
  expect((await sync(a, cloud)).state).toBe("idle");
  expect((await sync(b, cloud)).state).toBe("idle");
  return { cloud, a, b };
}

/** Runs both devices until neither has anything left to send. */
async function settle(cloud: MemoryCloud, ...devices: Device[]) {
  for (let i = 0; i < 3; i++) for (const device of devices) expect((await sync(device, cloud)).state).toBe("idle");
  for (const device of devices) expect(await dirty(device.db)).toEqual([]);
}

describe("sync cycle", () => {
  test("an edit on A reaches B", async () => {
    const { cloud, a, b } = await twoDevices();
    expect((await note(b.db, "n1"))).toBeNull();
    await addNote(a.db, "n1", "hello", 10);
    await sync(a, cloud);
    const result = await sync(b, cloud);
    expect(result.applied).toEqual(["notes"]);
    expect(await notes(b)).toEqual(["n1:hello"]);
    // Applied rows are not dirty on B, and the second pull is empty.
    expect(await dirty(b.db)).toEqual([]);
    expect((await sync(b, cloud)).applied).toEqual([]);
  });

  test("the newer of two edits wins on both devices", async () => {
    const { cloud, a, b } = await twoDevices();
    await addNote(a.db, "n1", "first", 10);
    await settle(cloud, a, b);
    await editNote(a.db, "n1", "A at 30", 30);
    await editNote(b.db, "n1", "B at 20", 20);
    await settle(cloud, b, a);
    expect(await notes(a)).toEqual(["n1:A at 30"]);
    expect(await notes(b)).toEqual(["n1:A at 30"]);
  });

  test("equal stamps settle on the same row on both devices", async () => {
    const { cloud, a, b } = await twoDevices();
    await addNote(a.db, "n1", "first", 10);
    await settle(cloud, a, b);
    await editNote(a.db, "n1", "apple", 30);
    await editNote(b.db, "n1", "banana", 30);
    await settle(cloud, a, b);
    expect(await notes(a)).toEqual(await notes(b));
  });

  test("a delete loses to a later edit, and wins over an earlier one", async () => {
    const { cloud, a, b } = await twoDevices();
    await addNote(a.db, "n1", "one", 10);
    await addNote(a.db, "n2", "two", 10);
    await settle(cloud, a, b);
    await a.db.runAsync("UPDATE notes SET deleted_at = 20, updated_at = 20 WHERE id IN ('n1', 'n2')");
    await editNote(b.db, "n1", "edited later", 25);
    await editNote(b.db, "n2", "edited earlier", 15);
    await settle(cloud, a, b);
    expect(await notes(a)).toEqual(["n1:edited later", "n2:two (deleted)"]);
    expect(await notes(b)).toEqual(await notes(a));
  });

  test("a first sync of two devices that both have data keeps both", async () => {
    const cloud = createMemoryCloud();
    const a = await openDevice("device-a");
    const b = await openDevice("device-b");
    await addFolder(a.db, "f1", "inbox", 1);
    await addNote(a.db, "a1", "from A", 5);
    await addFolder(b.db, "f2", "work", 2);
    await addNote(b.db, "b1", "from B", 6, "f2");
    await settle(cloud, a, b);
    expect(await notes(a)).toEqual(["a1:from A", "b1:from B"]);
    expect(await notes(b)).toEqual(await notes(a));
  });

  test("seeded rows never clobber an edited copy", async () => {
    const cloud = createMemoryCloud();
    const a = await openDevice("device-a");
    await addFolder(a.db, "default", "", 0);
    await a.db.runAsync("UPDATE folders SET name = 'Renamed', updated_at = 50 WHERE id = 'default'");
    await sync(a, cloud);
    // A fresh install seeds the same row and syncs for the first time.
    const b = await openDevice("device-b");
    await addFolder(b.db, "default", "", 0);
    await settle(cloud, b, a);
    const name = async (device: Device) => (await device.db.getFirstAsync<{ name: string }>("SELECT name FROM folders WHERE id = 'default'"))?.name;
    expect(await name(a)).toBe("Renamed");
    expect(await name(b)).toBe("Renamed");
    // An untouched seed is never uploaded.
    const c = await openDevice("device-c");
    await addFolder(c.db, "other-seed", "", 0);
    await sync(c, cloud);
    expect(cloud.records().some((r) => r.id === "other-seed")).toBe(false);
  });

  test("a newer schema version on another device holds the cycle", async () => {
    const { cloud, a, b } = await twoDevices();
    await addNote(a.db, "n1", "old app", 10);
    await sync(a, cloud);
    await sync(b, cloud, {}, { ...CONFIG, schemaVersion: 2 });
    await editNote(b.db, "n1", "new app", 20);
    await sync(b, cloud, {}, { ...CONFIG, schemaVersion: 2 });
    await editNote(a.db, "n1", "old app again", 30);
    expect((await sync(a, cloud)).state).toBe("needsAppUpdate");
    expect(await notes(a)).toEqual(["n1:old app again"]);
    expect(cloud.records().find((r) => r.id === "n1")?.payload).toContain("new app");
  });

  test("a conflict on push: the server record wins when newer, ours is resent when newer", async () => {
    const { cloud, a, b } = await twoDevices();
    await addNote(a.db, "n1", "one", 10);
    await addNote(a.db, "n2", "two", 10);
    await settle(cloud, a, b);
    await editNote(b.db, "n1", "B older", 20);
    await editNote(b.db, "n2", "B newer", 40);
    // A saves both rows after B's pull and before B's push.
    const transport = memoryTransport(cloud);
    const racing: Transport = {
      ...transport,
      push: async (records, context) => {
        for (const id of ["n1", "n2"]) {
          const current = cloud.records().find((r) => r.id === id)!;
          cloud.put({ ...current, updatedAt: 30, payload: payloadOf({ ...JSON.parse(current.payload), body: `A ${id}`, updated_at: 30 }) });
        }
        racing.push = transport.push;
        return transport.push(records, context);
      },
    };
    const result = await runCycle(b.db, CONFIG, racing);
    expect(result.state).toBe("idle");
    expect(result.applied).toEqual(["notes"]);
    expect(await notes(b)).toEqual(["n1:A n1", "n2:B newer"]);
    expect(await dirty(b.db)).toEqual([]);
    await settle(cloud, a, b);
    expect(await notes(a)).toEqual(["n1:A n1", "n2:B newer"]);
  });

  test("a row edited while its push is in flight stays dirty", async () => {
    const { cloud, a } = await twoDevices();
    await addNote(a.db, "n1", "sent", 10);
    const transport = memoryTransport(cloud);
    await runCycle(a.db, CONFIG, {
      ...transport,
      push: async (records, context) => {
        await editNote(a.db, "n1", "edited meanwhile", 11);
        return transport.push(records, context);
      },
    });
    expect(await dirty(a.db)).toEqual(["notes/n1"]);
    await sync(a, cloud);
    expect(cloud.records().find((r) => r.id === "n1")?.payload).toContain("edited meanwhile");
  });

  test("quota: pushes stop, pulls go on", async () => {
    const { cloud, a, b } = await twoDevices();
    await addNote(b.db, "b1", "from B", 10);
    await sync(b, cloud);
    cloud.quotaExceeded = true;
    await addNote(a.db, "a1", "stuck", 10);
    expect((await sync(a, cloud)).state).toBe("quotaExceeded");
    expect(await notes(a)).toEqual(["a1:stuck", "b1:from B"]);
    expect(await dirty(a.db)).toEqual(["notes/a1"]);
    // Paused until the next launch or foreground, even once space is free.
    cloud.quotaExceeded = false;
    expect((await sync(a, cloud, { pushPaused: true })).state).toBe("quotaExceeded");
    expect((await sync(a, cloud)).state).toBe("idle");
    expect(await dirty(a.db)).toEqual([]);
  });

  test("retry: the cycle stops and passes on the delay", async () => {
    const { cloud, a } = await twoDevices();
    await addNote(a.db, "a1", "later", 10);
    cloud.retryNextPushMs = 5_000;
    expect(await sync(a, cloud)).toMatchObject({ state: "idle", retry: true, retryAfterMs: 5_000 });
    expect(await dirty(a.db)).toEqual(["notes/a1"]);
    await sync(a, cloud);
    expect(await dirty(a.db)).toEqual([]);
  });

  test("an expired cursor resets: everything is pulled and pushed again, nothing lost", async () => {
    const { cloud, a, b } = await twoDevices();
    await addNote(a.db, "a1", "from A", 10);
    await addNote(b.db, "b1", "from B", 10);
    await sync(a, cloud);
    cloud.expireCursors();
    await editNote(a.db, "a1", "from A, edited", 20);
    expect((await sync(a, cloud)).state).toBe("idle");
    expect((await sync(b, cloud)).state).toBe("idle");
    await settle(cloud, a, b);
    expect(await notes(a)).toEqual(["a1:from A, edited", "b1:from B"]);
    expect(await notes(b)).toEqual(await notes(a));
  });

  test("a wiped cloud (zone deleted) is refilled from the devices", async () => {
    const { cloud, a, b } = await twoDevices();
    await addNote(a.db, "a1", "kept", 10);
    await settle(cloud, a, b);
    await memoryTransport(cloud).wipe();
    await settle(cloud, b, a);
    expect(cloud.records().map((r) => r.id).sort()).toEqual(["a1", "f1"]);
  });

  test("pages are pulled until the cloud has no more, parents applied before children", async () => {
    const { cloud, a, b } = await twoDevices();
    for (let i = 0; i < 7; i++) await addNote(a.db, `n${i}`, `note ${i}`, 10 + i);
    await addFolder(a.db, "f9", "late folder", 20);
    await addNote(a.db, "child", "in the late folder", 21, "f9");
    await sync(a, cloud);
    cloud.pageSize = 3;
    expect((await sync(b, cloud)).state).toBe("idle");
    expect((await notes(b)).length).toBe(8);
  });

  test("the push goes out in batches of 200", async () => {
    const { cloud, a } = await twoDevices();
    for (let i = 0; i < 450; i++) await addNote(a.db, `n${i}`, "x", 10);
    const sizes: number[] = [];
    const transport = memoryTransport(cloud);
    await runCycle(a.db, CONFIG, { ...transport, push: (records, context) => (sizes.push(records.length), transport.push(records, context)) });
    expect(sizes).toEqual([200, 200, 50]);
    expect(await dirty(a.db)).toEqual([]);
  });

  test("excluded settings never leave the phone", async () => {
    const { cloud, a, b } = await twoDevices();
    await a.db.runAsync("INSERT INTO settings (key, value, updated_at) VALUES ('pro', '1', 5), ('theme', 'dark', 5)");
    await settle(cloud, a, b);
    expect(cloud.records().filter((r) => r.table === "settings").map((r) => r.id)).toEqual(["theme"]);
    // A record for an excluded key (another app version's config) is ignored.
    cloud.put({ table: "settings", id: "pro", updatedAt: 99, schemaVersion: 1, payload: payloadOf({ key: "pro", value: "1", updated_at: 99 }) });
    await sync(b, cloud);
    expect(await b.db.getFirstAsync("SELECT * FROM settings WHERE key = 'pro'")).toBeNull();
  });

  test("account states stop the cycle and touch nothing", async () => {
    const { cloud, a } = await twoDevices();
    await addNote(a.db, "a1", "local", 10);
    cloud.account = { state: "none" };
    expect((await sync(a, cloud)).state).toBe("signedOut");
    cloud.account = { state: "restricted" };
    expect((await sync(a, cloud)).state).toBe("unavailable");
    cloud.account = { state: "available", id: "someone-else" };
    expect((await sync(a, cloud)).state).toBe("accountChanged");
    cloud.failure = "offline";
    expect(await sync(a, cloud)).toMatchObject({ state: "error", error: "offline" });
    cloud.failure = null;
    await setMeta(a.db, "enabled", "0");
    expect((await sync(a, cloud)).state).toBe("off");
    expect(await notes(a)).toEqual(["a1:local"]);
    expect(await dirty(a.db)).toEqual(["notes/a1"]);
  });
});

describe("CloudSync", () => {
  const create = (device: Device, cloud: MemoryCloud) => createCloudSyncWith(device.db, CONFIG, memoryTransport(cloud), { writePollMs: 5 });

  test("calls made while a cycle runs share its promise; listeners hear status and remote changes", async () => {
    const { cloud, a, b } = await twoDevices();
    await addNote(a.db, "a1", "hello", 10);
    await sync(a, cloud);
    const syncB = create(b, cloud);
    const states: string[] = [];
    const changes: string[][] = [];
    syncB.subscribe((status) => states.push(status.state));
    syncB.onRemoteChange((tables) => changes.push(tables));
    const first = syncB.syncNow();
    expect(syncB.syncNow()).toBe(first);
    const status = await first;
    expect(status).toMatchObject({ state: "idle", pending: 0, accountLabel: "memory@example.com" });
    expect(status.lastSyncedAt).toBeNumber();
    expect(states).toEqual(["syncing", "idle"]);
    expect(changes).toEqual([["notes"]]);
  });

  test("a local write is noticed and synced without the app calling anything", async () => {
    const { cloud, a } = await twoDevices();
    const syncA = create(a, cloud);
    syncA.start();
    await syncA.syncNow();
    await addNote(a.db, "a1", "written", 10);
    for (let i = 0; i < 50 && !cloud.records().some((r) => r.id === "a1"); i++) await Bun.sleep(5);
    syncA.stop();
    expect(cloud.records().some((r) => r.id === "a1")).toBe(true);
  });

  test("turning sync off and on again pushes what changed meanwhile", async () => {
    const { cloud, a } = await twoDevices();
    const syncA = create(a, cloud);
    await syncA.setEnabled(false);
    expect(syncA.getStatus().state).toBe("off");
    await addNote(a.db, "a1", "while off", 10);
    await syncA.setEnabled(true);
    expect(syncA.getStatus().state).toBe("idle");
    expect(cloud.records().some((r) => r.id === "a1")).toBe(true);
  });

  test("account change: nothing syncs until the device adopts the new account, then it merges", async () => {
    const { cloud, a } = await twoDevices();
    await addNote(a.db, "a1", "mine", 10);
    await sync(a, cloud);
    // Another account whose cloud already has data.
    const other = createMemoryCloud({ state: "available", id: "account-2", label: "two@example.com" });
    other.put({ table: "folders", id: "f1", updatedAt: 1, schemaVersion: 1, payload: payloadOf({ id: "f1", name: "inbox", updated_at: 1, deleted_at: null }) });
    other.put({ table: "notes", id: "x1", updatedAt: 5, schemaVersion: 1, payload: payloadOf({ id: "x1", folder_id: "f1", body: "theirs", updated_at: 5, deleted_at: null }) });
    const syncA = create(a, other);
    expect((await syncA.syncNow()).state).toBe("accountChanged");
    expect(other.records().some((r) => r.id === "a1")).toBe(false);
    await syncA.adoptAccount();
    expect(syncA.getStatus().state).toBe("idle");
    expect(await getMeta(a.db, "account_id")).toBe("account-2");
    expect(await notes(a)).toEqual(["a1:mine", "x1:theirs"]);
    expect(other.records().some((r) => r.id === "a1")).toBe(true);
  });

  test("sign out keeps local data, can delete the cloud copy, and a sign in merges again", async () => {
    const { cloud, a } = await twoDevices();
    await addNote(a.db, "a1", "mine", 10);
    const transport = memoryTransport(cloud);
    let signedIn = true;
    const syncA = createCloudSyncWith(a.db, CONFIG, {
      ...transport,
      account: async () => (signedIn ? transport.account() : { state: "none" }),
      signIn: async () => (signedIn = true),
      signOut: async () => void (signedIn = false),
    });
    await syncA.syncNow();
    await syncA.signOut({ deleteCloudCopy: true });
    expect(syncA.getStatus().state).toBe("signedOut");
    expect(cloud.records()).toEqual([]);
    expect(await notes(a)).toEqual(["a1:mine"]);
    expect(await syncA.signIn()).toBe(true);
    expect(syncA.getStatus().state).toBe("idle");
    expect(cloud.records().map((r) => r.id).sort()).toEqual(["a1", "f1"]);
  });

  test("going to the background folds the WAL into the database file, signed in or not", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cloud-sync-wal-"));
    try {
      const path = join(dir, "app.db");
      const file = new Database(path);
      file.exec("PRAGMA journal_mode = WAL");
      const db = openTestDatabase(file);
      await db.execAsync(SCHEMA);
      await installSyncWith(db, CONFIG, "device-a");
      await addFolder(db, "f1", "inbox", 1);
      await addNote(db, "n1", "written just now", 10);
      expect(statSync(`${path}-wal`).size).toBeGreaterThan(0);

      // Never signed in: Auto Backup is all this user has.
      const cloud = createMemoryCloud({ state: "none" });
      let toState: (state: string) => void = () => undefined;
      const syncA = createCloudSyncWith(db, CONFIG, memoryTransport(cloud), {
        appState: { current: () => "active", listen: (listener) => ((toState = listener), () => undefined) },
      });
      syncA.start();
      toState("background");
      for (let i = 0; i < 50 && statSync(`${path}-wal`).size > 0; i++) await Bun.sleep(5);
      syncA.stop();
      expect(syncA.getStatus().state).toBe("signedOut");
      expect(statSync(`${path}-wal`).size).toBe(0);
      file.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("without a transport it only reports unavailable", async () => {
    const a = await openDevice();
    const syncA = createCloudSyncWith(a.db, CONFIG, undefined);
    expect((await syncA.syncNow()).state).toBe("unavailable");
    expect(await syncA.signIn()).toBe(false);
  });
});

const setting = (device: Device, key: string) =>
  device.db.getFirstAsync<{ value: string }>("SELECT value FROM settings WHERE key = ?", key).then((row) => row?.value);
const putSetting = (device: Device, key: string, value: string, at: number) =>
  device.db.runAsync(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    key,
    value,
    at,
  );
const cloudSetting = (cloud: MemoryCloud, key: string) =>
  cloud.records().find((record) => record.table === "settings" && record.id === key)?.payload;

describe("a new install (HAU-792)", () => {
  test("a setting written before the first download does not replace the cloud copy", async () => {
    const cloud = createMemoryCloud();
    const a = await openDevice("device-a");
    await putSetting(a, "plates", "kg, no 25s", 10);
    await sync(a, cloud);

    // Reinstall: the app writes its defaults (a tip closed, a switch flipped) before sync has run once.
    const b = await openDevice("device-b", CONFIG, { fresh: true });
    await putSetting(b, "plates", "defaults", 1_000);
    await addFolder(b.db, "f2", "made on b", 1_000);
    expect((await sync(b, cloud)).state).toBe("idle");

    expect(await setting(b, "plates")).toBe("kg, no 25s");
    expect(cloudSetting(cloud, "plates")).toContain("kg, no 25s");
    // Rows the cloud does not have still go up.
    expect(cloud.records().some((record) => record.id === "f2")).toBe(true);
    expect(await getMeta(b.db, "fresh")).toBeNull();

    // After the first download the newer edit wins again.
    await putSetting(b, "plates", "lbs", 2_000);
    await sync(b, cloud);
    expect(cloudSetting(cloud, "plates")).toContain("lbs");
  });

  test("with an empty cloud the new install's rows go up", async () => {
    const cloud = createMemoryCloud();
    const b = await openDevice("device-b", CONFIG, { fresh: true });
    await putSetting(b, "plates", "mine", 5);
    expect((await sync(b, cloud)).state).toBe("idle");
    expect(cloudSetting(cloud, "plates")).toContain("mine");
    expect(await getMeta(b.db, "fresh")).toBeNull();
  });

  test("a pull that fails keeps the install new", async () => {
    const cloud = createMemoryCloud();
    const b = await openDevice("device-b", CONFIG, { fresh: true });
    const failing: Transport = { ...memoryTransport(cloud), pull: async () => Promise.reject(new Error("offline")) };
    expect((await runCycle(b.db, CONFIG, failing)).state).toBe("error");
    expect(await getMeta(b.db, "fresh")).toBe("1");
  });

  test("a restored database keeps the newer-row rule, so the restore wins", async () => {
    const cloud = createMemoryCloud();
    const a = await openDevice("device-a");
    await putSetting(a, "plates", "before the restore", 10);
    await sync(a, cloud);

    const phone = await openDevice("phone-1");
    await putSetting(phone, "plates", "restored", 50);
    await installSyncWith(phone.db, CONFIG, "phone-2");
    await sync(phone, cloud);
    expect(await setting(phone, "plates")).toBe("restored");
    expect(cloudSetting(cloud, "plates")).toContain("restored");
  });
});
