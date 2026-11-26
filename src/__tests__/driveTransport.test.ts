import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { createCloudSyncWith } from "../cloudSync";
import { runCycle } from "../cycle";
import { getMeta, installSyncWith } from "../install";
import { openTestDatabase } from "../testing/testDatabase";
import { COMPACT_ROWS, driveTransport, fileName, REVOKE_WAIT_MS, type DriveFileBody } from "../drive/driveTransport";
import type { Transport } from "../types";
import { createFakeDrive, type FakeDrive } from "./fakeDrive";
import { addFolder, addNote, CONFIG, dirty, editNote, openDevice, type Device } from "./fixtures";

type DriveDevice = Device & { transport: Transport };

const transportFor = (drive: FakeDrive, deviceId: string) =>
  driveTransport({ app: CONFIG.app, deviceId: async () => deviceId, auth: drive.auth, fetch: (input, init) => drive.fetch(input, init), sleep: drive.sleep, now: () => 1 });

async function deviceOn(drive: FakeDrive, deviceId: string): Promise<DriveDevice> {
  const device = await openDevice(deviceId);
  return { ...device, transport: transportFor(drive, deviceId) };
}

const sync = (device: DriveDevice) => runCycle(device.db, CONFIG, device.transport);

const notes = async (device: Device) =>
  (await device.db.getAllAsync<{ id: string; body: string; deleted_at: number | null }>("SELECT id, body, deleted_at FROM notes ORDER BY id")).map(
    (row) => `${row.id}:${row.body}${row.deleted_at ? " (deleted)" : ""}`,
  );

const fileBody = (drive: FakeDrive, deviceId: string, kind: "base" | "delta") => {
  const file = drive.byName(fileName(CONFIG.app, deviceId, kind));
  return file ? (JSON.parse(file.content) as DriveFileBody) : undefined;
};
const ids = (body: DriveFileBody | undefined) => body?.records.map((record) => `${record.table}/${record.id}`).sort();

/** Runs every device until none has anything left to send. */
async function settle(...devices: DriveDevice[]) {
  for (let i = 0; i < 3; i++) for (const device of devices) expect((await sync(device)).state).toBe("idle");
  for (const device of devices) expect(await dirty(device.db)).toEqual([]);
}

/** Two devices on one Google account, each with the shared folder f1 already synced. */
async function twoDevices() {
  const drive = createFakeDrive();
  const a = await deviceOn(drive, "device-a");
  const b = await deviceOn(drive, "device-b");
  await addFolder(a.db, "f1", "inbox", 1);
  await settle(a, b);
  return { drive, a, b };
}

describe("drive transport", () => {
  test("two devices converge, and each writes only its own two files", async () => {
    const { drive, a, b } = await twoDevices();
    await addNote(a.db, "n1", "from A", 10);
    await addNote(b.db, "n2", "from B", 11);
    await settle(a, b);
    expect(await notes(a)).toEqual(["n1:from A", "n2:from B"]);
    expect(await notes(b)).toEqual(await notes(a));

    await editNote(a.db, "n1", "A at 30", 30);
    await editNote(b.db, "n1", "B at 20", 20);
    await settle(b, a);
    expect(await notes(a)).toEqual(["n1:A at 30", "n2:from B"]);
    expect(await notes(b)).toEqual(await notes(a));

    expect(drive.names()).toEqual([
      "test.device-a.base.json",
      "test.device-a.delta.json",
      "test.device-b.base.json",
      "test.device-b.delta.json",
    ]);
    // B wrote only its own row; f1 and A's rows live in A's files.
    const bRecords = [...(fileBody(drive, "device-b", "base")?.records ?? []), ...(fileBody(drive, "device-b", "delta")?.records ?? [])];
    expect(new Set(bRecords.map((record) => record.id))).toEqual(new Set(["n2", "n1"]));
    expect(fileBody(drive, "device-a", "base")).toMatchObject({ format: 1, app: "test", schemaVersion: 1, deviceId: "device-a" });
  });

  test("a quiet cycle lists once and downloads nothing", async () => {
    const { drive, a } = await twoDevices();
    drive.requests.length = 0;
    expect((await sync(a)).state).toBe("idle");
    expect(drive.requests).toEqual(["GET /drive/v3/files"]);
  });

  test("the delta folds into the base past a fifth of the rows or 200 rows", async () => {
    const { drive, a, b } = await twoDevices();
    for (let i = 0; i < 20; i++) await addNote(a.db, `n${String(i).padStart(2, "0")}`, "x", 10);
    await sync(a);
    expect(fileBody(drive, "device-a", "base")?.records).toHaveLength(21);
    expect(fileBody(drive, "device-a", "delta")?.records).toEqual([]);

    // Small edits stay in the delta...
    for (const id of ["n00", "n01", "n02"]) await editNote(a.db, id, "edited", 20);
    await sync(a);
    expect(ids(fileBody(drive, "device-a", "delta"))).toEqual(["notes/n00", "notes/n01", "notes/n02"]);
    expect(fileBody(drive, "device-a", "base")?.records.find((record) => record.id === "n00")?.updatedAt).toBe(10);
    // ...until they pass a fifth of all rows.
    for (const id of ["n03", "n04"]) await editNote(a.db, id, "edited", 20);
    await sync(a);
    expect(fileBody(drive, "device-a", "delta")?.records).toEqual([]);
    expect(fileBody(drive, "device-a", "base")?.records.filter((record) => record.updatedAt === 20)).toHaveLength(5);

    // Past 200 rows the delta folds in however big the base is.
    for (let i = 0; i < 1100; i++) await addNote(a.db, `m${String(i).padStart(4, "0")}`, "x", 10);
    await sync(a);
    for (let i = 0; i < COMPACT_ROWS; i++) await editNote(a.db, `m${String(i).padStart(4, "0")}`, "y", 20);
    await sync(a);
    expect(fileBody(drive, "device-a", "delta")?.records).toHaveLength(COMPACT_ROWS);
    await editNote(a.db, "m1000", "y", 20);
    await sync(a);
    expect(fileBody(drive, "device-a", "delta")?.records).toEqual([]);

    await settle(b);
    expect(await notes(b)).toEqual(await notes(a));
  });

  test("a device that reads between the base and the delta write still converges", async () => {
    const { drive, a, b } = await twoDevices();
    for (let i = 0; i < 10; i++) await addNote(a.db, `n${i}`, "x", 10);
    await settle(a, b);
    for (let i = 0; i < 4; i++) await editNote(a.db, `n${i}`, "edited", 20);

    // A compacts: the new base lands, then B syncs before the delta is emptied.
    let midWrite: Promise<unknown> | undefined;
    drive.beforeWrite = async (name) => {
      if (name !== "test.device-a.delta.json" || midWrite) return;
      midWrite = sync(b);
      await midWrite;
    };
    await sync(a);
    expect(midWrite).toBeDefined();
    drive.beforeWrite = undefined;
    expect(await notes(b)).toEqual(await notes(a));

    // And the other order: B lists the old versions, then A rewrites both files before B downloads them.
    for (let i = 4; i < 9; i++) await editNote(a.db, `n${i}`, "again", 30);
    const original = drive.fetch;
    let raced = false;
    drive.fetch = async (input, init) => {
      if (!raced && input.includes("alt=media")) {
        raced = true;
        await sync(a);
      }
      return original(input, init);
    };
    await sync(b);
    drive.fetch = original;
    expect(raced).toBe(true);
    await settle(b);
    expect(await notes(b)).toEqual(await notes(a));
  });

  test("a refused token is cleared, refreshed silently and the call retried once", async () => {
    const { drive, a, b } = await twoDevices();
    await addNote(a.db, "n1", "hello", 10);
    drive.expireToken();
    expect((await sync(a)).state).toBe("idle");
    expect(drive.cleared).toEqual(["token-0"]);
    await settle(b);
    expect(await notes(b)).toEqual(["n1:hello"]);

    // The grant was withdrawn on the Google account page: signed out, data kept.
    drive.granted = false;
    drive.valid.clear();
    expect((await sync(a)).state).toBe("signedOut");
    expect(await notes(a)).toEqual(["n1:hello"]);
  });

  test("rate limits and server errors are retried with backoff", async () => {
    const { drive, a, b } = await twoDevices();
    await addNote(a.db, "n1", "hello", 10);
    drive.failures.push({ status: 403, reason: "userRateLimitExceeded" }, { status: 429 }, { status: 503 });
    expect((await sync(a)).state).toBe("idle");
    expect(drive.slept).toEqual([1000, 2000, 4000]);
    await settle(b);
    expect(await notes(b)).toEqual(["n1:hello"]);

    // Out of retries on an upload: the push asks the cycle to retry later and the row stays dirty.
    await editNote(a.db, "n1", "again", 20);
    for (let i = 0; i < 4; i++) drive.failures.push({ status: 500, method: "PUT" });
    const result = await sync(a);
    expect(result).toMatchObject({ state: "idle", retry: true });
    expect(await dirty(a.db)).toEqual(["notes/n1"]);
    expect((await sync(a)).retry).toBeUndefined();
    expect(await dirty(a.db)).toEqual([]);
  });

  test("a full Drive stops pushes with quotaExceeded; pulls go on", async () => {
    const { drive, a, b } = await twoDevices();
    await addNote(b.db, "n2", "from B", 10);
    await sync(b);
    drive.quotaFull = true;
    await addNote(a.db, "n1", "from A", 10);
    expect((await sync(a)).state).toBe("quotaExceeded");
    expect(await notes(a)).toEqual(["n1:from A", "n2:from B"]);
    expect(await dirty(a.db)).toEqual(["notes/n1"]);
    drive.quotaFull = false;
    await settle(a, b);
    expect(await notes(b)).toEqual(["n1:from A", "n2:from B"]);
  });

  test("list pages are followed", async () => {
    const drive = createFakeDrive();
    drive.pageSize = 1;
    const devices = [await deviceOn(drive, "device-a"), await deviceOn(drive, "device-b"), await deviceOn(drive, "device-c")];
    await addFolder(devices[0].db, "f1", "inbox", 1);
    await addFolder(devices[1].db, "f1", "inbox", 1);
    await addNote(devices[1].db, "n1", "b", 10, "f1");
    await addFolder(devices[2].db, "f1", "inbox", 1);
    await addNote(devices[2].db, "n2", "c", 10, "f1");
    await settle(...devices);
    for (const device of devices) expect(await notes(device)).toEqual(["n1:b", "n2:c"]);
  });

  test("a fresh install (pm clear) gets everything back after signing in", async () => {
    const { drive, a } = await twoDevices();
    await addNote(a.db, "n1", "kept", 10);
    await settle(a);
    const fresh = await deviceOn(drive, "device-a2");
    await settle(fresh);
    expect(await notes(fresh)).toEqual(["n1:kept"]);
  });

  test("a relaunched device reads its own files back before writing", async () => {
    const { drive, a, b } = await twoDevices();
    await addNote(a.db, "n1", "one", 10);
    await settle(a);
    const relaunched = { ...a, transport: transportFor(drive, "device-a") };
    await addNote(relaunched.db, "n2", "two", 10);
    await settle(relaunched, b);
    expect(await notes(b)).toEqual(["n1:one", "n2:two"]);
    expect(drive.names().filter((name) => name.startsWith("test.device-a"))).toHaveLength(2);
  });

  test("deleted Drive app data is pushed again from the device", async () => {
    const { drive, a, b } = await twoDevices();
    await addNote(a.db, "n1", "mine", 10);
    await settle(a);
    drive.files.clear();
    expect((await sync(a)).state).toBe("idle");
    expect(ids(fileBody(drive, "device-a", "base"))).toEqual(["folders/f1", "notes/n1"]);
    await settle(b);
    expect(await notes(b)).toEqual(["n1:mine"]);
  });

  test("an own file deleted under the device (404 on update) is written again", async () => {
    const { drive, a } = await twoDevices();
    await addNote(a.db, "n1", "mine", 10);
    await settle(a);
    drive.files.delete(drive.byName("test.device-a.delta.json")!.id);
    await editNote(a.db, "n1", "edited", 20);
    expect((await sync(a)).state).toBe("idle");
    const records = [...(fileBody(drive, "device-a", "base")?.records ?? []), ...(fileBody(drive, "device-a", "delta")?.records ?? [])];
    expect(records.find((record) => record.id === "n1")?.updatedAt).toBe(20);
  });

  test("other apps' files in the folder are ignored", async () => {
    const { drive, a } = await twoDevices();
    const other = transportFor(drive, "x");
    const payload = JSON.stringify({ body: "from x", deleted_at: null, folder_id: "f1", id: "n9", updated_at: 5 });
    await other.push([{ table: "notes", id: "n9", updatedAt: 5, schemaVersion: 1, payload }], { deviceId: "x", app: "test", schemaVersion: 1 });
    const foreign = driveTransport({ app: "other", deviceId: async () => "y", auth: drive.auth, fetch: drive.fetch, sleep: drive.sleep });
    await foreign.push([{ table: "notes", id: "z", updatedAt: 5, schemaVersion: 1, payload: "{}" }], { deviceId: "y", app: "other", schemaVersion: 1 });
    expect(drive.names()).toContain("other.y.base.json");
    await foreign.wipe();
    expect(drive.names().some((name) => name.startsWith("other."))).toBe(false);
    // A's two files and x's: B has written nothing yet.
    expect(drive.names().filter((name) => name.startsWith("test.")).length).toBe(4);
    expect((await sync(a)).state).toBe("idle");
    expect(await notes(a)).toEqual(["n9:from x"]);
  });

  test("sign out keeps local data and revokes; delete synced copy empties the folder", async () => {
    const { drive, a, b } = await twoDevices();
    await addNote(a.db, "n1", "mine", 10);
    await settle(a, b);
    const syncA = createCloudSyncWith(a.db, CONFIG, a.transport);
    expect((await syncA.syncNow()).accountLabel).toBe("test@example.com");

    await syncA.signOut({ deleteCloudCopy: false });
    expect(drive.revoked).toEqual(["test@example.com"]);
    expect(syncA.getStatus().state).toBe("signedOut");
    expect(await notes(a)).toEqual(["n1:mine"]);
    expect(drive.names()).toEqual(["test.device-a.base.json", "test.device-a.delta.json"]);

    expect(await syncA.signIn()).toBe(true);
    expect(syncA.getStatus().state).toBe("idle");
    await syncA.signOut({ deleteCloudCopy: true });
    expect(drive.names()).toEqual([]);
    expect(syncA.getStatus().state).toBe("signedOut");
    expect(await notes(a)).toEqual(["n1:mine"]);
    expect(await notes(b)).toEqual(["n1:mine"]);
  });

  test("signed out stays signed out across a relaunch, though Google still hands out tokens (HAU-778)", async () => {
    const { drive, a } = await twoDevices();
    await addNote(a.db, "n1", "mine", 10);
    const before = createCloudSyncWith(a.db, CONFIG, a.transport);
    expect((await before.syncNow()).state).toBe("idle");
    await before.signOut({ deleteCloudCopy: false });
    expect(drive.granted).toBe(true);

    const relaunched = createCloudSyncWith(a.db, CONFIG, a.transport);
    await addNote(a.db, "n2", "offline", 20);
    expect((await relaunched.syncNow()).state).toBe("signedOut");
    const uploaded = () => [...(ids(fileBody(drive, "device-a", "base")) ?? []), ...(ids(fileBody(drive, "device-a", "delta")) ?? [])];
    expect(uploaded()).not.toContain("notes/n2");

    expect(await relaunched.signIn()).toBe(true);
    expect(relaunched.getStatus().state).toBe("idle");
    expect(uploaded()).toContain("notes/n2");
  });

  test("sign out finishes when Google's revoke never answers (HAU-778)", async () => {
    const { drive, a } = await twoDevices();
    drive.revokeHangs = true;
    const syncA = createCloudSyncWith(a.db, CONFIG, a.transport);
    expect((await syncA.syncNow()).state).toBe("idle");
    await syncA.signOut({ deleteCloudCopy: false });
    expect(drive.revoked).toEqual(["test@example.com"]);
    expect(drive.slept).toContain(REVOKE_WAIT_MS);
    expect(syncA.getStatus().state).toBe("signedOut");
  });

  test("not signed in: signedOut until the user grants access", async () => {
    const drive = createFakeDrive();
    drive.granted = false;
    const a = await deviceOn(drive, "device-a");
    await addFolder(a.db, "f1", "inbox", 1);
    const syncA = createCloudSyncWith(a.db, CONFIG, a.transport);
    expect((await syncA.syncNow()).state).toBe("signedOut");
    expect(drive.requests).toEqual([]);
    expect(await syncA.signIn()).toBe(true);
    expect(syncA.getStatus()).toMatchObject({ state: "idle", accountLabel: "test@example.com", pending: 0 });
    expect(ids(fileBody(drive, "device-a", "base"))).toEqual(["folders/f1"]);
  });

  test("another Google account is noticed before anything is merged", async () => {
    const { drive, a } = await twoDevices();
    drive.account = { permissionId: "perm-2", emailAddress: "other@example.com" };
    drive.expireToken();
    await drive.auth.clearToken(drive.current);
    expect((await sync(a)).state).toBe("accountChanged");
  });

  test("sign out, then sign in to another Google account: asks first, and merges only after adoptAccount", async () => {
    const { drive: first, a } = await twoDevices();
    await addNote(a.db, "n1", "mine", 10);
    await settle(a);
    // The second account's Drive already holds another phone's notes.
    const second = createFakeDrive();
    second.account = { permissionId: "perm-2", emailAddress: "two@example.com" };
    second.current = "token-two";
    second.valid = new Set(["token-two"]);
    const phone = await deviceOn(second, "device-x");
    await addFolder(phone.db, "f1", "inbox", 1);
    await addNote(phone.db, "x1", "theirs", 20);
    await settle(phone);
    const beforeSecond = second.names();
    const beforeFirst = first.names();

    // One transport for device A, talking to whichever account the user picked.
    let current = first;
    const transport = driveTransport({
      app: CONFIG.app,
      deviceId: async () => "device-a",
      auth: {
        token: (interactive) => current.auth.token(interactive),
        clearToken: (token) => current.auth.clearToken(token),
        revoke: (email) => current.auth.revoke(email),
      },
      fetch: (input, init) => current.fetch(input, init),
      sleep: async () => undefined,
      now: () => 1,
    });
    const syncA = createCloudSyncWith(a.db, CONFIG, transport);
    expect((await syncA.syncNow()).state).toBe("idle");
    await syncA.signOut({ deleteCloudCopy: false });
    expect(syncA.getStatus().state).toBe("signedOut");

    current = second;
    expect(await syncA.signIn()).toBe(true);
    expect(syncA.getStatus()).toMatchObject({ state: "accountChanged", accountLabel: "two@example.com" });
    // Nothing moved either way while the app asks.
    expect(second.names()).toEqual(beforeSecond);
    expect(await notes(a)).toEqual(["n1:mine"]);
    expect((await syncA.syncNow()).state).toBe("accountChanged");

    await syncA.adoptAccount();
    expect(syncA.getStatus()).toMatchObject({ state: "idle", accountLabel: "two@example.com", pending: 0 });
    expect(await getMeta(a.db, "account_id")).toBe("perm-2");
    expect(await notes(a)).toEqual(["n1:mine", "x1:theirs"]);
    await settle(phone);
    expect(await notes(phone)).toEqual(["n1:mine", "x1:theirs"]);
    // The first account's copy is untouched.
    expect(first.names()).toEqual(beforeFirst);
    expect(ids(fileBody(first, "device-a", "base"))).toEqual(["folders/f1", "notes/n1"]);
  });

  test("an Auto Backup restore onto a new phone gets a new device id and merges, rows written just before the backup included", async () => {
    const { drive, a, b } = await twoDevices();
    await addNote(a.db, "n1", "synced", 10);
    await settle(a, b);
    // Written seconds before the backup: never synced.
    await addNote(a.db, "n2", "unsynced", 11);

    // The backup carries A's database (device id, cursor, account) to a phone whose no-backup id is new.
    const restored = openTestDatabase(Database.deserialize(a.file.serialize()));
    await installSyncWith(restored, CONFIG, "device-c");
    expect(await getMeta(restored, "device_id")).toBe("device-c");
    expect(await getMeta(restored, "cursor")).toBeNull();
    expect(await dirty(restored)).toEqual(["folders/f1", "notes/n1", "notes/n2"]);

    const c: DriveDevice = { db: restored, file: a.file, deviceId: "device-c", transport: transportFor(drive, "device-c") };
    // Same Google account as the backup's: no question, it merges.
    await settle(c, b);
    expect(await notes(c)).toEqual(["n1:synced", "n2:unsynced"]);
    expect(await notes(b)).toEqual(["n1:synced", "n2:unsynced"]);
    // C read A's files on its first pull, so only what was new to the cloud goes up under its own id.
    expect(ids(fileBody(drive, "device-c", "base"))).toEqual(["notes/n2"]);
    // A's files stay as they were; the restore never writes under the old id.
    expect(ids(fileBody(drive, "device-a", "base"))).toEqual(["folders/f1", "notes/n1"]);
  });

  test("a restore onto a phone signed in to another Google account asks before merging", async () => {
    const { a } = await twoDevices();
    const other = createFakeDrive();
    other.account = { permissionId: "perm-2", emailAddress: "two@example.com" };
    const restored = openTestDatabase(Database.deserialize(a.file.serialize()));
    await installSyncWith(restored, CONFIG, "device-c");
    const c: DriveDevice = { db: restored, file: a.file, deviceId: "device-c", transport: transportFor(other, "device-c") };
    expect((await sync(c)).state).toBe("accountChanged");
    expect(other.names()).toEqual([]);
  });
});
