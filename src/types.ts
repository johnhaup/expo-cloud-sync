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
  signOut(options: { deleteCloudCopy: boolean }): Promise<void>;
  /** After "accountChanged": merge this device's data into the new account. */
  adoptAccount(): Promise<void>;
}
