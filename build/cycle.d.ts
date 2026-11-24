import type { SQLiteDatabase } from "expo-sqlite";
import type { Account, SyncConfig, SyncState, Transport } from "./types";
export declare const PUSH_BATCH = 200;
export type CycleOptions = {
    /** After a quota error pushes wait for the next launch or foreground; pulls go on. */
    pushPaused?: boolean;
    now?: () => number;
};
export type CycleResult = {
    state: SyncState;
    /** Tables remote rows were written to. */
    applied: string[];
    account?: Account;
    /** The cloud asked to be retried later (`retryAfterMs` when it said how much later). */
    retry?: boolean;
    retryAfterMs?: number;
    error?: string;
};
/**
 * One sync cycle: check the account, pull every page and merge it, push the dirty set.
 * Never throws for a cloud error; the result carries the state to show.
 */
export declare function runCycle(db: SQLiteDatabase, config: SyncConfig, transport: Transport, options?: CycleOptions): Promise<CycleResult>;
