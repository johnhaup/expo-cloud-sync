import type { SQLiteDatabase } from "expo-sqlite";
import type { SyncConfig, SyncTable } from "./types";
/** A table's config with its defaults filled in. */
export type Table = {
    name: string;
    key: string;
    tombstone: string | null;
    excludeKeys: string[];
};
export declare const resolveTable: (table: SyncTable) => Table;
export declare const quote: (name: string) => string;
/** SQL condition on `column` that leaves out the table's excluded keys ("1" when there are none). */
export declare const notExcluded: (table: Table, column: string) => string;
export type MetaKey = "applying" | "enabled" | "device_id" | "account_id" | "cursor" | "last_synced_at" | "hold" | "fresh" | "signed_out";
export declare const getMeta: (db: SQLiteDatabase, key: MetaKey) => Promise<string | null>;
export declare const setMeta: (db: SQLiteDatabase, key: MetaKey, value: string) => Promise<import("expo-sqlite").SQLiteRunResult>;
export declare const deleteMeta: (db: SQLiteDatabase, key: MetaKey) => Promise<import("expo-sqlite").SQLiteRunResult>;
export declare const columnsOf: (db: SQLiteDatabase, table: string) => Promise<string[]>;
/** Every row with a real stamp becomes dirty: the start of a first sync. Seeded rows (stamp 0) stay out. */
export declare function markAllDirty(db: SQLiteDatabase, config: SyncConfig): Promise<void>;
/**
 * Forget what this device knew about the cloud copy (cursor, change tags) and mark everything dirty,
 * so the next cycle pulls everything and pushes what wins here. Nothing local is deleted.
 */
export declare function beginFirstSync(db: SQLiteDatabase, config: SyncConfig): Promise<void>;
/**
 * Creates the _sync tables and triggers and runs restore detection. Call after migrate(), before the
 * first read. `deviceId` is the native id kept outside every backup: a database whose stored id differs
 * came from another install (a restore or transfer) and starts a first sync.
 */
export declare function installSyncWith(db: SQLiteDatabase, config: SyncConfig, deviceId: string): Promise<void>;
