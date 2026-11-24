import type { SQLiteDatabase } from "expo-sqlite";
import type { CloudSync, SyncConfig, Transport } from "./types";
/** iOS launch argument (`-cloudSyncMock YES`) that swaps the cloud for an in-memory one with a signed-in account. */
export declare const CLOUD_SYNC_MOCK_FLAG = "cloudSyncMock";
/** Creates the _sync tables and triggers and runs restore detection. Call after migrate(), before the first read. */
export declare function installSync(db: SQLiteDatabase, config: SyncConfig, options?: {
    deviceId?: string;
}): Promise<void>;
/**
 * The sync for one database: CKSyncEngine on iOS, the pull/push cycle over Google Drive's appDataFolder on
 * Android. A passed transport (or the memory cloud with `-cloudSyncMock`) replaces the platform's.
 */
export declare function createCloudSync(db: SQLiteDatabase, config: SyncConfig, transport?: Transport): CloudSync;
