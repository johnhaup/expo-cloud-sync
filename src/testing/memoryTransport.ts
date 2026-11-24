import type { Account, PushResult, SyncRecord, Transport } from "../types";

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

type Entry = { record: SyncRecord; seq: number };

export type MemoryCloudInternal = MemoryCloud & {
  entries: Map<string, Entry>;
  seq: number;
  epoch: number;
};

const keyOf = (record: { table: string; id: string }) => `${record.table}/${record.id}`;

export function createMemoryCloud(account: Account = { state: "available", id: "memory-account", label: "memory@example.com" }): MemoryCloud {
  let tags = 0;
  const cloud: MemoryCloudInternal = {
    account,
    pageSize: 100,
    quotaExceeded: false,
    retryNextPushMs: null,
    failure: null,
    entries: new Map(),
    seq: 0,
    epoch: 0,
    expireCursors: () => {
      cloud.epoch++;
    },
    put: (record) => {
      const saved = { ...record, sys: `tag-${++tags}` };
      cloud.entries.set(keyOf(record), { record: saved, seq: ++cloud.seq });
    },
    records: () => [...cloud.entries.values()].sort((a, b) => a.seq - b.seq).map(({ record }) => record),
  };
  return cloud;
}

export function memoryTransport(publicCloud: MemoryCloud): Transport {
  const cloud = publicCloud as MemoryCloudInternal;
  const check = () => {
    if (cloud.failure) throw new Error(cloud.failure);
  };
  return {
    account: async () => {
      check();
      return { ...cloud.account };
    },
    pull: async (cursor) => {
      check();
      let after = 0;
      if (cursor !== null) {
        const [epoch, seq] = cursor.split(":").map(Number);
        if (epoch !== cloud.epoch) return { records: [], cursor: "", more: false, reset: true };
        after = seq;
      }
      const changed = [...cloud.entries.values()].filter((entry) => entry.seq > after).sort((a, b) => a.seq - b.seq);
      const page = changed.slice(0, cloud.pageSize);
      const last = page.length ? page[page.length - 1].seq : after;
      return {
        records: page.map(({ record }) => ({ ...record })),
        cursor: `${cloud.epoch}:${last}`,
        more: changed.length > page.length,
      };
    },
    push: async (records) => {
      check();
      if (cloud.retryNextPushMs !== null) {
        const retryAfterMs = cloud.retryNextPushMs;
        cloud.retryNextPushMs = null;
        return records.map((record) => ({ table: record.table, id: record.id, result: "failed", reason: "retry", retryAfterMs }));
      }
      return records.map((record): PushResult => {
        const { table, id } = record;
        if (cloud.quotaExceeded) return { table, id, result: "failed", reason: "quota" };
        const existing = cloud.entries.get(keyOf(record));
        if (existing && record.sys !== existing.record.sys) return { table, id, result: "conflict", server: { ...existing.record } };
        cloud.put(record);
        return { table, id, result: "saved", sys: cloud.entries.get(keyOf(record))!.record.sys };
      });
    },
    wipe: async () => {
      check();
      cloud.entries.clear();
      cloud.epoch++;
    },
  };
}
