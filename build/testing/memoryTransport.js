const keyOf = (record) => `${record.table}/${record.id}`;
export function createMemoryCloud(account = { state: "available", id: "memory-account", label: "memory@example.com" }) {
    let tags = 0;
    const cloud = {
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
export function memoryTransport(publicCloud) {
    const cloud = publicCloud;
    const check = () => {
        if (cloud.failure)
            throw new Error(cloud.failure);
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
                if (epoch !== cloud.epoch)
                    return { records: [], cursor: "", more: false, reset: true };
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
            return records.map((record) => {
                const { table, id } = record;
                if (cloud.quotaExceeded)
                    return { table, id, result: "failed", reason: "quota" };
                const existing = cloud.entries.get(keyOf(record));
                if (existing && record.sys !== existing.record.sys)
                    return { table, id, result: "conflict", server: { ...existing.record } };
                cloud.put(record);
                return { table, id, result: "saved", sys: cloud.entries.get(keyOf(record)).record.sys };
            });
        },
        wipe: async () => {
            check();
            cloud.entries.clear();
            cloud.epoch++;
        },
    };
}
