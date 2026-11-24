import type { SQLiteDatabase } from "expo-sqlite";
import { type Table } from "./install";
import type { Account, SyncConfig, SyncRecord, SyncState } from "./types";
/**
 * What both sync paths share: Android's pull/push cycle (`cycle.ts`) and iOS's CKSyncEngine driver
 * (`engineSync.ts`) merge remote records, settle sent ones and read the dirty set through these.
 */
export type Context = {
    db: SQLiteDatabase;
    config: SyncConfig;
    tables: Map<string, Table>;
    columns: Map<string, string[]>;
    /** Tables remote rows were written to since the caller last cleared it. */
    applied: Set<string>;
};
export declare function createContext(db: SQLiteDatabase, config: SyncConfig): Promise<Context>;
export declare const holdFor: (config: SyncConfig) => string;
/** Why sync cannot run right now, before any account check: off, or held for an app update. */
export declare function gate(db: SQLiteDatabase, config: SyncConfig): Promise<"off" | "needsAppUpdate" | undefined>;
/** The state an account puts sync in, or undefined when it may run. Stores the first account seen. */
export declare function accountGate(db: SQLiteDatabase, account: Account): Promise<SyncState | undefined>;
/**
 * A record from a newer app version stops everything before it is applied: an old app would strip the new
 * columns and push the row back. Sets the hold and returns true when `records` holds one.
 */
export declare function holdForNewerSchema(ctx: Context, records: SyncRecord[]): Promise<boolean>;
/** Runs `task` in an exclusive transaction with the triggers silenced and foreign keys checked at commit. */
export declare function applying(db: SQLiteDatabase, task: (txn: SQLiteDatabase) => Promise<void>): Promise<void>;
/** Merges fetched records (parents first) inside an `applying` transaction. */
export declare function mergeRecords(ctx: Context, txn: SQLiteDatabase, records: SyncRecord[]): Promise<void>;
/** A save went through: keep its change tag; the row stops being dirty unless it was edited again while in flight. */
export declare function settleSaved(ctx: Context, txn: SQLiteDatabase, saved: {
    table: string;
    id: string;
    sys?: string;
    updatedAt: number;
}): Promise<void>;
/**
 * The cloud holds a different version (CloudKit `serverRecordChanged`): `decide` against it. Returns true
 * when the local row won and must be sent again, now on top of the server's change tag.
 */
export declare function settleConflict(ctx: Context, txn: SQLiteDatabase, server: SyncRecord): Promise<boolean>;
/** The dirty rows as records, parents first. Dirty entries that cannot be pushed are dropped. */
export declare function dirtyRecords(ctx: Context): Promise<SyncRecord[]>;
export declare const countPending: (db: SQLiteDatabase) => Promise<number>;
