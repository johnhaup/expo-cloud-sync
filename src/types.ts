/** A row in transit, the same on both platforms. */
export type SyncRecord = {
  table: string;
  /** The row's key. */
  id: string;
  /** ms since epoch, the row's updated_at. */
  updatedAt: number;
  /** The app's SCHEMA_VERSION when it was written. */
  schemaVersion: number;
  /** JSON of the whole row, column name -> value, keys sorted. */
  payload: string;
  /** iOS only: base64 of the CKRecord system fields. */
  sys?: string;
};

export type SyncTable = {
  name: string;
  /** Default "id". */
  key?: string;
  /** Default "deleted_at"; null for a table without tombstones (settings). */
  tombstone?: string | null;
  /** Rows never synced (settings that belong to the phone). */
  excludeKeys?: string[];
  /** Ticket M7: column holding a file name under Paths.document/sync-files. */
  fileColumn?: string;
};

/** `tables` lists parents before children. */
export type SyncConfig = { app: string; schemaVersion: number; tables: SyncTable[] };

export type SyncState =
  | "off"
  | "unavailable"
  | "signedOut"
  | "idle"
  | "syncing"
  | "accountChanged"
  | "quotaExceeded"
  | "needsAppUpdate"
  | "error";

export type SyncStatus = {
  state: SyncState;
  lastSyncedAt?: number;
  /** Android: the Google account's email (with `accountChanged`, the new account's). iOS: none, iCloud gives no label. */
  accountLabel?: string;
  /** Rows changed here and not yet in the cloud. */
  pending: number;
  error?: string;
};

export type Account = { state: "available" | "none" | "restricted"; id?: string; label?: string };

export type PullResult = { records: SyncRecord[]; cursor: string; more: boolean; reset?: boolean };

export type PushResult = { table: string; id: string } & (
  | { result: "saved"; sys?: string }
  | { result: "conflict"; server: SyncRecord }
  | { result: "failed"; reason: "quota" | "retry" | "other"; retryAfterMs?: number }
);

/** What a transport may need about the pushing device (the Drive transport names its files after it). */
export type PushContext = { deviceId: string; app: string; schemaVersion: number };

export interface Transport {
  account(): Promise<Account>;
  pull(cursor: string | null): Promise<PullResult>;
  push(records: SyncRecord[], context: PushContext): Promise<PushResult[]>;
  /** Delete the cloud copy. */
  wipe(): Promise<void>;
  /** Android: the consent UI. Without it, signing in means an account is available. */
  signIn?(): Promise<boolean>;
  /** Android: revoke access. */
  signOut?(): Promise<void>;
}

/** iOS: what CKSyncEngine reports about one record it tried to save. */
export type EngineSaveResult = { table: string; id: string } & (
  | { result: "saved"; sys: string; updatedAt: number }
  | { result: "conflict"; server: SyncRecord }
  | { result: "failed"; reason: "quota" | "other"; message?: string }
);

/** iOS: CKSyncEngine's events as the native module forwards them, in order. */
export type EngineEvent =
  /** The engine's serialized `State` changed: persist it (it replaces the cursor on iOS). */
  | { type: "stateUpdate"; state: string }
  /** `fetchedRecordZoneChanges`: records another device saved. */
  | { type: "fetched"; records: SyncRecord[] }
  /** `sentRecordZoneChanges`: what happened to the records handed over with `enqueue`. Transient errors never show up here. */
  | { type: "sent"; results: EngineSaveResult[] }
  /** `fetchedDatabaseChanges` deleted the zone (user deleted iCloud data, reset): native recreates it, JS re-sends everything. */
  | { type: "zoneDeleted" }
  /** `accountChange`: sign in, sign out or another account. */
  | { type: "accountChange" }
  /** A failure that belongs to no record (saving the zone). */
  | { type: "error"; reason: "quota" | "other"; message?: string }
  /** `willFetchChanges` / `willSendChanges`. */
  | { type: "willSync" }
  /** `didFetchChanges` (`fetched: true`) / `didSendChanges`. */
  | { type: "didSync"; fetched?: boolean };

/**
 * iOS: the native CKSyncEngine host. It owns scheduling, change tokens, retries and push; JS owns the database,
 * the merge and the engine's persisted state. Implemented by `native.ts` and by a fake in tests.
 */
export interface SyncEngine {
  account(): Promise<Account>;
  /** Creates the engine from its persisted state (null: a first sync) with the dirty rows already pending. */
  start(state: string | null, pending: SyncRecord[]): Promise<void>;
  /** Hands over rows to save: native keeps their payloads, so building a batch never waits on JS. */
  enqueue(records: SyncRecord[]): Promise<void>;
  /** Fetch, then send, now. */
  sync(): Promise<void>;
  /** Cancels and drops the engine; its last persisted state stays with JS. */
  stop(): Promise<void>;
  /** Delete the cloud copy (the zone). */
  wipe(): Promise<void>;
  addListener(listener: (event: EngineEvent) => void): () => void;
}

export interface CloudSync {
  /** AppState listener, the write timer, the remote-notification listener. */
  start(): void;
  stop(): void;
  /** One cycle; calls made while one runs share its promise. */
  syncNow(): Promise<SyncStatus>;
  getStatus(): SyncStatus;
  subscribe(listener: (status: SyncStatus) => void): () => void;
  /** Called after remote rows were written, with the tables touched. */
  onRemoteChange(listener: (tables: string[]) => void): () => void;
  setEnabled(enabled: boolean): Promise<void>;
  /** Android: consent UI. iOS: resolves true when an iCloud account exists. */
  signIn(): Promise<boolean>;
  /**
   * Android: revoke Google access and stop syncing (`signedOut`). iOS: turn sync off on this device (`off`).
   * Local data is always kept, and so is the account's id: signing in to a different account later shows
   * `accountChanged` instead of merging.
   *
   * `deleteCloudCopy` deletes this app's synced copy from the account (every device's files in the Drive
   * appDataFolder; the iCloud zone). It is not permanent while another device is still signed in to the same
   * account with sync on: that device notices the copy is gone and uploads all of its rows again on its next
   * sync. The app's Settings copy must say so, e.g. "Deletes the synced copy from your Google Drive. Other
   * devices still signed in will upload their data again; sign out on them first."
   */
  signOut(options: { deleteCloudCopy: boolean }): Promise<void>;
  /**
   * After `accountChanged`: merge this device's data into the new account (the app asks first: "Merge this
   * phone's data into <accountLabel>?"). Until it is called nothing syncs, in either direction.
   */
  adoptAccount(): Promise<void>;
}
