import type { SQLiteDatabase } from "expo-sqlite";

import {
  accountGate,
  applying,
  countPending,
  createContext,
  dirtyRecords,
  gate,
  holdForNewerSchema,
  mergeRecords,
  settleConflict,
  settleSaved,
  type Context,
} from "./apply";
import type { SyncEnvironment } from "./cloudSync";
import { beginFirstSync, deleteMeta, getMeta, setMeta } from "./install";
import type { CloudSync, EngineEvent, SyncConfig, SyncEngine, SyncRecord, SyncState, SyncStatus } from "./types";

const WRITE_POLL_MS = 2_000;

/** States that need something to change (the user, the account, an app update) before sync runs again. */
const STOPPED: SyncState[] = ["off", "signedOut", "unavailable", "accountChanged", "needsAppUpdate", "error"];

const keyOf = (record: { table: string; id: string }) => `${record.table}/${record.id}`;
/** A row is handed over again when its stamp or its change tag moved. */
const versionOf = (record: SyncRecord) => `${record.updatedAt}#${record.sys ?? ""}`;

/**
 * iOS: the sync driven by CKSyncEngine. The engine decides when to fetch and send; this forwards dirty rows
 * to it and merges what it reports, with the same rules as Android's cycle (`apply.ts`). The engine's
 * serialized state lives in `_sync_meta.cursor`, so everything that clears the cursor (restore detection,
 * a first sync, sign out) also makes the next engine start from scratch.
 *
 * Every event and every operation runs on one queue, in order: a state update is persisted only after the
 * records fetched before it were applied.
 */
export function createEngineSyncWith(db: SQLiteDatabase, config: SyncConfig, engine: SyncEngine, env: SyncEnvironment = {}): CloudSync {
  let status: SyncStatus = { state: "idle", pending: 0 };
  const listeners = new Set<(status: SyncStatus) => void>();
  const remoteListeners = new Set<(tables: string[]) => void>();
  let ctx: Context | undefined;
  let running = false;
  let pushPaused = false;
  /** Rows handed to the engine and not yet reported back, with the version they were handed over at. */
  let enqueued = new Map<string, string>();
  let lastPending = -1;
  let queue: Promise<unknown> = Promise.resolve();
  let timers: ReturnType<typeof setInterval>[] = [];
  let unsubscribers: (() => void)[] = [];

  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const next = queue.then(task);
    queue = next.catch(() => undefined);
    return next;
  };

  const emit = async (state: SyncState, error?: string) => {
    const lastSyncedAt = await getMeta(db, "last_synced_at");
    status = { state, pending: await countPending(db), lastSyncedAt: lastSyncedAt ? Number(lastSyncedAt) : undefined, error };
    listeners.forEach((listener) => listener(status));
  };

  const fail = (error: unknown) => emit("error", error instanceof Error ? error.message : String(error));

  const notifyApplied = () => {
    if (!ctx?.applied.size) return;
    const tables = [...ctx.applied];
    ctx.applied.clear();
    remoteListeners.forEach((listener) => listener(tables));
  };

  const stopEngine = async () => {
    if (!running) return;
    running = false;
    enqueued = new Map();
    await engine.stop();
  };

  /** Starts the engine when sync may run; otherwise stops it and shows why. Returns whether it runs. */
  const boot = async () => {
    const blocked = (await gate(db, config)) ?? (await accountGate(db, await engine.account()));
    if (blocked) {
      await stopEngine();
      await emit(blocked);
      return false;
    }
    if (!running) {
      ctx = await createContext(db, config);
      const pending = pushPaused ? [] : await dirtyRecords(ctx);
      await engine.start(await getMeta(db, "cursor"), pending);
      running = true;
      enqueued = new Map(pending.map((record) => [keyOf(record), versionOf(record)]));
      lastPending = await countPending(db);
      await emit(STOPPED.includes(status.state) ? "idle" : status.state);
    } else if (STOPPED.includes(status.state) || (status.state === "quotaExceeded" && !pushPaused)) {
      await emit("idle");
    }
    return true;
  };

  /** Hands the engine every dirty row it does not hold at its current version. */
  const flush = async () => {
    if (!running || pushPaused || !ctx) return;
    lastPending = await countPending(db);
    const records = (await dirtyRecords(ctx)).filter((record) => enqueued.get(keyOf(record)) !== versionOf(record));
    if (!records.length) return;
    for (const record of records) enqueued.set(keyOf(record), versionOf(record));
    await engine.enqueue(records);
  };

  const handle = async (event: EngineEvent) => {
    if (!running || !ctx) return;
    const context = ctx;
    switch (event.type) {
      case "stateUpdate":
        await setMeta(db, "cursor", event.state);
        return;
      case "fetched":
        if (await holdForNewerSchema(context, event.records)) {
          // The engine already moved past these records in memory; dropping it before its next state is
          // persisted makes the next start (after the app update) fetch them again.
          await stopEngine();
          await emit("needsAppUpdate");
          return;
        }
        await applying(db, (txn) => mergeRecords(context, txn, event.records));
        notifyApplied();
        await flush();
        await emit(status.state, status.error);
        return;
      case "sent": {
        let stop: { state: SyncState; error?: string } | undefined;
        await applying(db, async (txn) => {
          for (const result of event.results) {
            enqueued.delete(keyOf(result));
            if (result.result === "saved") await settleSaved(context, txn, result);
            else if (result.result === "conflict") await settleConflict(context, txn, result.server);
            else if (result.reason === "quota") stop = { state: "quotaExceeded" };
            else stop ??= { state: "error", error: result.message ?? `cloud-sync: iCloud refused ${keyOf(result)}` };
          }
        });
        notifyApplied();
        if (stop?.state === "quotaExceeded") pushPaused = true;
        if (stop) return emit(stop.state, stop.error);
        // Rows that won a conflict, or were edited while in flight, go out again.
        await flush();
        await emit(status.state, status.error);
        return;
      }
      case "zoneDeleted":
        // The cloud copy is gone (deleted in Settings, or reset): native recreates the zone, everything goes up again.
        await db.withTransactionAsync(() => beginFirstSync(db, config));
        enqueued = new Map();
        await flush();
        await emit(status.state, status.error);
        return;
      case "accountChange":
        if (await boot()) await flush();
        return;
      case "error":
        if (event.reason === "quota") pushPaused = true;
        await emit(event.reason === "quota" ? "quotaExceeded" : "error", event.message);
        return;
      case "willSync":
        if (status.state === "idle") await emit("syncing");
        return;
      case "didSync":
        if (status.state === "idle" || status.state === "syncing" || status.state === "error") {
          await setMeta(db, "last_synced_at", String((env.now ?? Date.now)()));
          await emit("idle");
        }
        return;
    }
  };

  const syncNow = async () => {
    try {
      await serial(async () => {
        if (!(await boot())) return;
        await flush();
        await engine.sync();
      });
      // Events the sync produced are queued behind it.
      await serial(async () => undefined);
    } catch (error) {
      await serial(() => fail(error));
    }
    return status;
  };

  /** The 2 s look for local writes: a change in the dirty count hands the new rows to the engine. */
  const lookForWrites = () =>
    serial(async () => {
      if (running && (await countPending(db)) !== lastPending) await flush();
    }).catch(fail);

  const stopTimers = () => {
    timers.forEach(clearInterval);
    timers = [];
  };
  const startTimers = () => {
    stopTimers();
    timers.push(setInterval(() => void lookForWrites(), env.writePollMs ?? WRITE_POLL_MS));
  };

  const sync: CloudSync = {
    start() {
      sync.stop();
      unsubscribers.push(engine.addListener((event) => void serial(() => handle(event)).catch(fail)));
      const appState = env.appState;
      if (appState) {
        unsubscribers.push(
          appState.listen((state) => {
            if (state === "active") {
              pushPaused = false;
              startTimers();
              void syncNow();
            } else if (state === "background") {
              stopTimers();
              void syncNow().then(() => db.execAsync("PRAGMA wal_checkpoint(TRUNCATE)").catch(() => undefined));
            }
          }),
        );
      }
      if (!appState || appState.current() === "active") startTimers();
      void syncNow();
    },
    stop() {
      stopTimers();
      unsubscribers.forEach((unsubscribe) => unsubscribe());
      unsubscribers = [];
      void serial(stopEngine).catch(fail);
    },
    syncNow,
    getStatus: () => status,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    onRemoteChange(listener) {
      remoteListeners.add(listener);
      return () => void remoteListeners.delete(listener);
    },
    async setEnabled(enabled) {
      await serial(async () => {
        await setMeta(db, "enabled", enabled ? "1" : "0");
        if (enabled && (await getMeta(db, "cursor")) === null) await db.withTransactionAsync(() => beginFirstSync(db, config));
      });
      await syncNow();
    },
    async signIn() {
      const signedIn = (await engine.account()).state === "available";
      if (signedIn) await sync.setEnabled(true);
      return signedIn;
    },
    /**
     * iOS has no sign-out of its own (that is iCloud's, in Settings): this turns sync off on this device and
     * forgets the engine's state, so turning it on again is a first sync that sends every row. `account_id`
     * stays, so another iCloud account later still asks before merging.
     */
    async signOut({ deleteCloudCopy }) {
      await serial(async () => {
        await stopEngine();
        if (deleteCloudCopy) await engine.wipe();
        await db.withTransactionAsync(async () => {
          await setMeta(db, "enabled", "0");
          await deleteMeta(db, "cursor");
          await db.runAsync("DELETE FROM _sync_rows");
        });
      });
      await syncNow();
    },
    async adoptAccount() {
      await serial(async () => {
        await stopEngine();
        const account = await engine.account();
        await db.withTransactionAsync(async () => {
          if (account.id) await setMeta(db, "account_id", account.id);
          await beginFirstSync(db, config);
        });
      });
      await syncNow();
    },
  };
  return sync;
}
