import type { Account, SyncRecord, Transport } from "../types";
/**
 * An in-memory cloud with CloudKit's semantics: each record has a change tag (`sys`), a save must name
 * the tag it last saw or it conflicts, and pulls page through a change feed. Shared by every device
 * (database) in a test or in the example app; the knobs below put it into each state the cycle handles.
 */
export type MemoryCloud = {
    account: Account;
    /** Records per pull page. */
    pageSize: number;
    /** Every push fails with `quota` while set. */
    quotaExceeded: boolean;
    /** The next push fails with `retry` and this delay, then the knob clears. */
    retryNextPushMs: number | null;
    /** Every call throws this while set (a network failure). */
    failure: string | null;
    /** Expires every cursor handed out so far: the next pull with one answers `reset` (CloudKit `changeTokenExpired`). */
    expireCursors(): void;
    /** Writes a record as another device would (a newer app version, a seeded test record). */
    put(record: Omit<SyncRecord, "sys">): void;
    records(): SyncRecord[];
};
type Entry = {
    record: SyncRecord;
    seq: number;
};
export type MemoryCloudInternal = MemoryCloud & {
    entries: Map<string, Entry>;
    seq: number;
    epoch: number;
};
export declare function createMemoryCloud(account?: Account): MemoryCloud;
export declare function memoryTransport(publicCloud: MemoryCloud): Transport;
export {};
