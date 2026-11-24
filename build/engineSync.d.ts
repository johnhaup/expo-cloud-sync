import type { SQLiteDatabase } from "expo-sqlite";
import type { SyncEnvironment } from "./cloudSync";
import type { CloudSync, SyncConfig, SyncEngine } from "./types";
/**
 * iOS: the sync driven by CKSyncEngine. The engine decides when to fetch and send; this forwards dirty rows
 * to it and merges what it reports, with the same rules as Android's cycle (`apply.ts`). The engine's
 * serialized state lives in `_sync_meta.cursor`, so everything that clears the cursor (restore detection,
 * a first sync, sign out) also makes the next engine start from scratch.
 *
 * Every event and every operation runs on one queue, in order: a state update is persisted only after the
 * records fetched before it were applied.
 */
export declare function createEngineSyncWith(db: SQLiteDatabase, config: SyncConfig, engine: SyncEngine, env?: SyncEnvironment): CloudSync;
