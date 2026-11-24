import { afterEach, describe, expect, test } from "bun:test";

import { createEngineSyncWith } from "../engineSync";
import { getMeta } from "../install";
import { payloadOf } from "../merge";
import type { Account, CloudSync, EngineEvent, SyncEngine, SyncRecord } from "../types";
import { addFolder, addNote, CONFIG, dirty, editNote, note, openDevice, type Device } from "./fixtures";

/** CKSyncEngine as the driver sees it: records what it is handed; the test plays its events. */
type Fake = {
  account: Account;
  running: boolean;
  starts: { state: string | null; pending: SyncRecord[] }[];
  /** Every record handed over, in order (start's pending ones included). */
  handed: SyncRecord[];
  syncs: number;
  wipes: number;
  emit: (event: EngineEvent) => void;
  engine: SyncEngine;
};

function fakeEngine(account: Account = { state: "available", id: "icloud-1" }): Fake {
  const listeners = new Set<(event: EngineEvent) => void>();
  const fake: Fake = {
    account,
    running: false,
    starts: [],
    handed: [],
    syncs: 0,
    wipes: 0,
    emit: (event: EngineEvent) => listeners.forEach((listener) => listener(event)),
    engine: {
      account: async () => ({ ...fake.account }),
      start: async (state, pending) => {
        fake.running = true;
        fake.starts.push({ state, pending });
        fake.handed.push(...pending);
      },
      enqueue: async (records) => void fake.handed.push(...records),
      sync: async () => void fake.syncs++,
      stop: async () => void (fake.running = false),
      wipe: async () => void fake.wipes++,
      addListener: (listener) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
    },
  };
  return fake;
}

const started: CloudSync[] = [];
afterEach(() => started.splice(0).forEach((sync) => sync.stop()));

async function startSync(device: Device, fake: Fake, now = () => 1_000) {
  const sync = createEngineSyncWith(device.db, CONFIG, fake.engine, { writePollMs: 5, now });
  started.push(sync);
  const remote: string[][] = [];
  sync.onRemoteChange((tables) => remote.push(tables));
  sync.start();
  await sync.syncNow();
  return { sync, remote };
}

const fakes = new Map<CloudSync, Fake>();

/** Plays engine events (the native module emits them; the driver queues them in order) and waits until handled. */
async function play(sync: CloudSync, ...events: EngineEvent[]) {
  for (const event of events) fakes.get(sync)!.emit(event);
  await sync.syncNow();
}

async function setup(account?: Account) {
  const device = await openDevice("device-a");
  await addFolder(device.db, "f1", "inbox", 1);
  const fake = fakeEngine(account);
  const { sync, remote } = await startSync(device, fake);
  fakes.set(sync, fake);
  return { device, fake, sync, remote };
}

const remoteNote = (id: string, body: string, updatedAt: number, sys = `sys-${id}-${updatedAt}`): SyncRecord => ({
  table: "notes",
  id,
  updatedAt,
  schemaVersion: CONFIG.schemaVersion,
  payload: payloadOf({ body, deleted_at: null, folder_id: "f1", id, updated_at: updatedAt }),
  sys,
});

const handedKeys = (fake: Fake) => fake.handed.map((record) => `${record.table}/${record.id}@${record.updatedAt}${record.sys ? `#${record.sys}` : ""}`);
const sysOf = (device: Device, id: string) =>
  device.db.getFirstAsync<{ sys: string }>("SELECT sys FROM _sync_rows WHERE table_name = 'notes' AND row_id = ?", id).then((row) => row?.sys);

describe("CKSyncEngine driver", () => {
  test("starts the engine with no state and every dirty row pending", async () => {
    const { fake, sync } = await setup();
    expect(fake.starts).toEqual([{ state: null, pending: [expect.objectContaining({ table: "folders", id: "f1", updatedAt: 1 })] }]);
    expect(fake.syncs).toBeGreaterThan(0);
    expect(sync.getStatus()).toMatchObject({ state: "idle", pending: 1 });
  });

  test("the engine's state is persisted and handed back on the next start", async () => {
    const { device, fake, sync } = await setup();
    await play(sync, { type: "stateUpdate", state: "c3RhdGUtMQ==" });
    expect(await getMeta(device.db, "cursor")).toBe("c3RhdGUtMQ==");
    sync.stop();
    await Bun.sleep(5); // the stop is queued
    expect(fake.running).toBe(false);

    const again = fakeEngine();
    await startSync(device, again);
    expect(again.starts[0].state).toBe("c3RhdGUtMQ==");
  });

  test("a local write is handed to the engine by the write timer", async () => {
    const { device, fake } = await setup();
    await addNote(device.db, "n1", "hello", 10);
    await Bun.sleep(30);
    expect(handedKeys(fake)).toEqual(["folders/f1@1", "notes/n1@10"]);
    // Handed once: nothing new on the next ticks.
    await Bun.sleep(30);
    expect(handedKeys(fake)).toHaveLength(2);
  });

  test("fetched records merge through decide", async () => {
    const { device, fake, sync, remote } = await setup();
    await addNote(device.db, "local-newer", "mine at 50", 50);
    await addNote(device.db, "local-older", "mine at 5", 5);
    await sync.syncNow();
    fake.handed.length = 0;
    await play(
      sync,
      { type: "fetched", records: [remoteNote("new", "from B", 20), remoteNote("local-newer", "B at 40", 40), remoteNote("local-older", "B at 30", 30)] },
    );
    expect((await note(device.db, "new"))?.body).toBe("from B");
    expect((await note(device.db, "local-newer"))?.body).toBe("mine at 50");
    expect((await note(device.db, "local-older"))?.body).toBe("B at 30");
    expect(remote).toEqual([["notes"]]);
    // Applied rows are clean; the local winner stays dirty and keeps the server's tag for its next save.
    expect(await dirty(device.db)).toEqual(["folders/f1", "notes/local-newer"]);
    expect(await sysOf(device, "local-older")).toBe("sys-local-older-30");
    expect(await sysOf(device, "local-newer")).toBe("sys-local-newer-40");
    expect(handedKeys(fake)).toEqual(["notes/local-newer@50#sys-local-newer-40"]);
  });

  test("a saved record stops being dirty unless it was edited while in flight", async () => {
    const { device, fake, sync } = await setup();
    await addNote(device.db, "n1", "one", 10);
    await addNote(device.db, "n2", "two", 10);
    await sync.syncNow();
    await editNote(device.db, "n2", "two again", 20);
    fake.handed.length = 0;
    await play(sync, {
      type: "sent",
      results: [
        { table: "folders", id: "f1", result: "saved", sys: "s-f1", updatedAt: 1 },
        { table: "notes", id: "n1", result: "saved", sys: "s-n1", updatedAt: 10 },
        { table: "notes", id: "n2", result: "saved", sys: "s-n2", updatedAt: 10 },
      ],
    });
    expect(await dirty(device.db)).toEqual(["notes/n2"]);
    expect(await sysOf(device, "n1")).toBe("s-n1");
    expect(handedKeys(fake)).toEqual(["notes/n2@20#s-n2"]);
    expect(sync.getStatus()).toMatchObject({ state: "idle", pending: 1 });
  });

  test("serverRecordChanged: the newer server record is applied, an older one is overwritten", async () => {
    const { device, fake, sync, remote } = await setup();
    await addNote(device.db, "lose", "mine at 10", 10);
    await addNote(device.db, "win", "mine at 50", 50);
    await sync.syncNow();
    fake.handed.length = 0;
    await play(sync, {
      type: "sent",
      results: [
        { table: "notes", id: "lose", result: "conflict", server: remoteNote("lose", "server at 20", 20, "srv-lose") },
        { table: "notes", id: "win", result: "conflict", server: remoteNote("win", "server at 40", 40, "srv-win") },
      ],
    });
    expect((await note(device.db, "lose"))?.body).toBe("server at 20");
    expect((await note(device.db, "win"))?.body).toBe("mine at 50");
    expect(remote).toEqual([["notes"]]);
    expect(await dirty(device.db)).toEqual(["folders/f1", "notes/win"]);
    // Sent again on top of the server's change tag.
    expect(handedKeys(fake)).toEqual(["notes/win@50#srv-win"]);
  });

  test("quota stops handing rows over until the app is foregrounded", async () => {
    const device = await openDevice("device-a");
    await addFolder(device.db, "f1", "inbox", 1);
    const fake = fakeEngine();
    let setState: (state: string) => void = () => undefined;
    const sync = createEngineSyncWith(device.db, CONFIG, fake.engine, {
      writePollMs: 5,
      appState: { current: () => "active", listen: (listener) => ((setState = listener), () => undefined) },
    });
    started.push(sync);
    fakes.set(sync, fake);
    sync.start();
    await sync.syncNow();
    await play(sync, { type: "sent", results: [{ table: "folders", id: "f1", result: "failed", reason: "quota" }] });
    expect(sync.getStatus().state).toBe("quotaExceeded");
    fake.handed.length = 0;
    await addNote(device.db, "n1", "hello", 10);
    await Bun.sleep(30);
    expect(fake.handed).toEqual([]);

    setState("active");
    await sync.syncNow();
    expect(sync.getStatus().state).toBe("idle");
    expect(handedKeys(fake)).toEqual(["folders/f1@1", "notes/n1@10"]);
  });

  test("another iCloud account: accountChanged and the engine stops; adopting starts over in the new account", async () => {
    const { device, fake, sync } = await setup();
    await play(sync, { type: "stateUpdate", state: "old-account-state" });
    fake.account = { state: "available", id: "icloud-2" };
    await play(sync, { type: "accountChange" });
    expect(sync.getStatus().state).toBe("accountChanged");
    expect(fake.running).toBe(false);

    await addNote(device.db, "n1", "hello", 10);
    await sync.adoptAccount();
    expect(await getMeta(device.db, "account_id")).toBe("icloud-2");
    expect(fake.starts.at(-1)).toEqual({
      state: null,
      pending: [expect.objectContaining({ id: "f1" }), expect.objectContaining({ id: "n1" })],
    });
    expect(sync.getStatus().state).toBe("idle");
  });

  test("iCloud sign-out keeps the data and shows signedOut; signing back in resumes", async () => {
    const { device, fake, sync } = await setup();
    await addNote(device.db, "n1", "hello", 10);
    fake.account = { state: "none" };
    await play(sync, { type: "accountChange" });
    expect(sync.getStatus().state).toBe("signedOut");
    expect(fake.running).toBe(false);
    expect((await note(device.db, "n1"))?.body).toBe("hello");

    fake.account = { state: "available", id: "icloud-1" };
    await sync.syncNow();
    expect(sync.getStatus().state).toBe("idle");
    expect(fake.running).toBe(true);
  });

  test("zone deleted: forget the change tags and the state, send every row again", async () => {
    const { device, fake, sync } = await setup();
    await addNote(device.db, "n1", "hello", 10);
    await sync.syncNow();
    await play(
      sync,
      { type: "sent", results: [
        { table: "folders", id: "f1", result: "saved", sys: "s-f1", updatedAt: 1 },
        { table: "notes", id: "n1", result: "saved", sys: "s-n1", updatedAt: 10 },
      ] },
      { type: "stateUpdate", state: "before-delete" },
    );
    expect(await dirty(device.db)).toEqual([]);
    fake.handed.length = 0;

    await play(sync, { type: "zoneDeleted" });
    expect(await getMeta(device.db, "cursor")).toBeNull();
    expect(await sysOf(device, "n1")).toBeUndefined();
    expect(handedKeys(fake)).toEqual(["folders/f1@1", "notes/n1@10"]);
  });

  test("a record from a newer app version holds sync without applying it or persisting the engine's state", async () => {
    const { device, fake, sync } = await setup();
    await play(sync, { type: "stateUpdate", state: "before" });
    await play(
      sync,
      { type: "fetched", records: [{ ...remoteNote("n9", "from the future", 20), schemaVersion: CONFIG.schemaVersion + 1 }] },
      { type: "stateUpdate", state: "after" },
    );
    expect(sync.getStatus().state).toBe("needsAppUpdate");
    expect(await note(device.db, "n9")).toBeNull();
    expect(await getMeta(device.db, "cursor")).toBe("before");
    expect(fake.running).toBe(false);
    const starts = fake.starts.length;
    await sync.syncNow();
    expect(fake.starts).toHaveLength(starts);
  });

  test("the engine's will/did events drive syncing and idle", async () => {
    const { device, sync } = await setup();
    const states: string[] = [];
    sync.subscribe((status) => states.push(status.state));
    await play(sync, { type: "willSync" }, { type: "didSync" });
    expect(states).toContain("syncing");
    expect(sync.getStatus()).toMatchObject({ state: "idle", lastSyncedAt: 1_000 });
    expect(await getMeta(device.db, "last_synced_at")).toBe("1000");
  });

  test("turning sync off stops the engine", async () => {
    const { fake, sync } = await setup();
    await sync.setEnabled(false);
    expect(sync.getStatus().state).toBe("off");
    expect(fake.running).toBe(false);
    await sync.setEnabled(true);
    expect(fake.running).toBe(true);
  });

  test("delete iCloud copy: wipes the zone, turns sync off here, and turning it on sends every row again", async () => {
    const { device, fake, sync } = await setup();
    await play(sync, { type: "stateUpdate", state: "engine-state" });
    await sync.signOut({ deleteCloudCopy: true });
    expect(fake.wipes).toBe(1);
    expect(fake.running).toBe(false);
    expect(sync.getStatus().state).toBe("off");
    expect(await getMeta(device.db, "cursor")).toBeNull();
    expect(await getMeta(device.db, "account_id")).toBe("icloud-1");

    await sync.setEnabled(true);
    expect(fake.starts.at(-1)).toEqual({ state: null, pending: [expect.objectContaining({ id: "f1" })] });
    expect(sync.getStatus().state).toBe("idle");
  });

  test("after turning sync off, another iCloud account still asks before merging", async () => {
    const { device, fake, sync } = await setup();
    await addNote(device.db, "n1", "mine", 10);
    await sync.signOut({ deleteCloudCopy: false });
    fake.account = { state: "available", id: "icloud-2" };
    await sync.setEnabled(true);
    expect(sync.getStatus().state).toBe("accountChanged");
    expect(fake.running).toBe(false);
    await sync.adoptAccount();
    expect(await getMeta(device.db, "account_id")).toBe("icloud-2");
    expect(fake.starts.at(-1)?.pending.map((record) => record.id)).toEqual(["f1", "n1"]);
  });
});
