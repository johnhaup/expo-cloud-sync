import type { SQLiteDatabase } from "expo-sqlite";

import { countPending } from "./apply";
import { runCycle } from "./cycle";
import { beginFirstSync, deleteMeta, getMeta, setMeta } from "./install";
import type { CloudSync, SyncConfig, SyncStatus, Transport } from "./types";

/** What the sync needs from the platform; `create.ts` wires React Native's AppState, tests pass fakes. */
export type SyncEnvironment = {
  appState?: { current: () => string; listen: (listener: (state: string) => void) => () => void };
  /** How often to look for local writes while active. */
  writePollMs?: number;
  /** A periodic cycle while active (Android has no push). */
  foregroundPollMs?: number;
  now?: () => number;
};

const WRITE_POLL_MS = 2_000;
const RETRY_FIRST_MS = 30_000;
const RETRY_MAX_MS = 15 * 60_000;

/**
 * The sync for one database. Without a transport (a platform not built yet) it only reports `unavailable`.
 * Call `installSync` before creating it.
 */
export function createCloudSyncWith(
  db: SQLiteDatabase,
  config: SyncConfig,
  transport: Transport | undefined,
  env: SyncEnvironment = {},
): CloudSync {
  let status: SyncStatus = { state: transport ? "idle" : "unavailable", pending: 0 };
  const listeners = new Set<(status: SyncStatus) => void>();
  const remoteListeners = new Set<(tables: string[]) => void>();
  let running: Promise<SyncStatus> | null = null;
  let pushPaused = false;
  let retryMs = RETRY_FIRST_MS;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let timers: ReturnType<typeof setInterval>[] = [];
  let unsubscribers: (() => void)[] = [];

  const emit = (next: SyncStatus) => {
    status = next;
    listeners.forEach((listener) => listener(status));
  };

  const cycle = async (): Promise<SyncStatus> => {
    if (!transport) return status;
    emit({ ...status, state: "syncing", error: undefined });
    const result = await runCycle(db, config, transport, { pushPaused, now: env.now });
    if (result.state === "quotaExceeded") pushPaused = true;
    if (result.retry) {
      const wait = result.retryAfterMs ?? retryMs;
      retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void syncNow();
      }, wait);
    } else if (result.state === "idle") {
      retryMs = RETRY_FIRST_MS;
    }
    const lastSyncedAt = await getMeta(db, "last_synced_at");
    emit({
      state: result.state,
      pending: await countPending(db),
      lastSyncedAt: lastSyncedAt ? Number(lastSyncedAt) : undefined,
      accountLabel: result.account?.label,
      error: result.error,
    });
    if (result.applied.length) remoteListeners.forEach((listener) => listener(result.applied));
    return status;
  };

  const syncNow = () => {
    running ??= cycle().finally(() => {
      running = null;
    });
    return running;
  };

  /** The 2 s look for local writes: a dirty row starts a cycle, unless sync is stopped on a state that needs the user. */
  const lookForWrites = async () => {
    if (running || retryTimer || status.state !== "idle") return;
    const pending = await countPending(db);
    if (pending > 0) void syncNow();
  };

  const stopTimers = () => {
    timers.forEach(clearInterval);
    timers = [];
  };

  const startTimers = () => {
    stopTimers();
    timers.push(setInterval(() => void lookForWrites(), env.writePollMs ?? WRITE_POLL_MS));
    if (env.foregroundPollMs) timers.push(setInterval(() => void syncNow(), env.foregroundPollMs));
  };

  const firstSyncIfNeeded = async () => {
    if ((await getMeta(db, "cursor")) === null) await db.withTransactionAsync(() => beginFirstSync(db, config));
  };

  const sync: CloudSync = {
    start() {
      sync.stop();
      if (!transport) return;
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
              // Flush, then fold the WAL into the main file so a device backup holds one complete file.
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
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      unsubscribers.forEach((unsubscribe) => unsubscribe());
      unsubscribers = [];
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
      await running;
      await setMeta(db, "enabled", enabled ? "1" : "0");
      if (enabled) await firstSyncIfNeeded();
      await syncNow();
    },
    async signIn() {
      if (!transport) return false;
      const signedIn = transport.signIn ? await transport.signIn() : (await transport.account()).state === "available";
      if (signedIn) await sync.setEnabled(true);
      return signedIn;
    },
    async signOut({ deleteCloudCopy }) {
      if (!transport) return;
      await running;
      if (deleteCloudCopy) await transport.wipe();
      await transport.signOut?.();
      // `account_id` stays: signing in to another account later asks before merging (`accountChanged`).
      await db.withTransactionAsync(async () => {
        await deleteMeta(db, "cursor");
        await db.runAsync("DELETE FROM _sync_rows");
      });
      await syncNow();
    },
    async adoptAccount() {
      if (!transport) return;
      await running;
      const account = await transport.account();
      await db.withTransactionAsync(async () => {
        if (account.id) await setMeta(db, "account_id", account.id);
        await beginFirstSync(db, config);
      });
      await syncNow();
    },
  };
  return sync;
}
