import type { SQLiteBindValue, SQLiteDatabase } from "expo-sqlite";

import {
  beginFirstSync,
  columnsOf,
  deleteMeta,
  getMeta,
  notExcluded,
  quote,
  resolveTable,
  setMeta,
  type Table,
} from "./install";
import { decide, payloadOf, type Row } from "./merge";
import type { Account, SyncConfig, SyncRecord, SyncState, Transport } from "./types";

export const PUSH_BATCH = 200;
const PUSH_ROUNDS = 3;

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

type Context = {
  db: SQLiteDatabase;
  config: SyncConfig;
  tables: Map<string, Table>;
  columns: Map<string, string[]>;
  applied: Set<string>;
};

const holdFor = (config: SyncConfig) => `needsAppUpdate@${config.schemaVersion}`;

/** Runs `task` in an exclusive transaction with the triggers silenced and foreign keys checked at commit. */
async function applying(db: SQLiteDatabase, task: (txn: SQLiteDatabase) => Promise<void>) {
  await db.withExclusiveTransactionAsync(async (txn) => {
    await txn.execAsync("PRAGMA defer_foreign_keys = ON");
    await setMeta(txn, "applying", "1");
    await task(txn);
    await deleteMeta(txn, "applying");
  });
}

async function localRow(db: SQLiteDatabase, table: Table, id: string) {
  const row = await db.getFirstAsync<Row>(`SELECT * FROM ${quote(table.name)} WHERE ${quote(table.key)} = ?`, id);
  return row ? { updatedAt: Number(row.updated_at), payload: payloadOf(row) } : undefined;
}

/** Writes a remote record. Only columns that exist here are written; missing ones keep their value or take the default. */
async function applyRecord(ctx: Context, txn: SQLiteDatabase, table: Table, record: SyncRecord) {
  const columns = ctx.columns.get(table.name)!;
  const values = JSON.parse(record.payload) as Row;
  const row: Row = {};
  for (const column of columns) if (column in values) row[column] = values[column];
  row[table.key] = record.id;
  row.updated_at = record.updatedAt;
  const names = Object.keys(row);
  const update = names.filter((name) => name !== table.key);
  await txn.runAsync(
    `INSERT INTO ${quote(table.name)} (${names.map(quote).join(", ")}) VALUES (${names.map(() => "?").join(", ")})
     ON CONFLICT (${quote(table.key)}) DO ${
       update.length ? `UPDATE SET ${update.map((name) => `${quote(name)} = excluded.${quote(name)}`).join(", ")}` : "NOTHING"
     }`,
    names.map((name) => row[name] as SQLiteBindValue),
  );
  ctx.applied.add(table.name);
}

const storeSys = (txn: SQLiteDatabase, record: { table: string; id: string }, sys: string | undefined) =>
  sys === undefined
    ? Promise.resolve()
    : txn.runAsync(
        `INSERT INTO _sync_rows (table_name, row_id, sys) VALUES (?, ?, ?)
         ON CONFLICT (table_name, row_id) DO UPDATE SET sys = excluded.sys`,
        record.table,
        record.id,
        sys,
      );

const markDirty = (txn: SQLiteDatabase, table: string, id: string) =>
  txn.runAsync("INSERT OR REPLACE INTO _sync_changes (table_name, row_id) VALUES (?, ?)", table, id);

/** Merges one remote record into the database inside an `applying` transaction. */
async function merge(ctx: Context, txn: SQLiteDatabase, record: SyncRecord) {
  const table = ctx.tables.get(record.table);
  if (!table || table.excludeKeys.includes(record.id)) return;
  const verdict = decide(await localRow(txn, table, record.id), record);
  if (verdict === "apply") await applyRecord(ctx, txn, table, record);
  // The local row won: it must reach the cloud even if it was not dirty.
  if (verdict === "keep") await markDirty(txn, table.name, record.id);
  await storeSys(txn, record, record.sys);
}

const byTableOrder = (config: SyncConfig) => {
  const order = new Map(config.tables.map((table, index) => [table.name, index]));
  return (a: SyncRecord, b: SyncRecord) => (order.get(a.table) ?? 0) - (order.get(b.table) ?? 0);
};

type Stop = Pick<CycleResult, "state" | "retry" | "retryAfterMs" | "error">;

/** Pulls until the cloud has nothing more. Returns a state when the cycle must stop. */
async function pull(ctx: Context, transport: Transport): Promise<Stop | undefined> {
  const { db, config } = ctx;
  let cursor = await getMeta(db, "cursor");
  let reset = false;
  for (;;) {
    const page = await transport.pull(cursor);
    if (page.reset) {
      if (reset) throw new Error("cloud-sync: the cloud asked for a reset twice in one cycle");
      reset = true;
      await db.withTransactionAsync(() => beginFirstSync(db, config));
      cursor = null;
      continue;
    }
    // A record from a newer app version stops everything before it is applied: an old app would strip
    // the new columns and push the row back.
    if (page.records.some((record) => record.schemaVersion > config.schemaVersion)) {
      await setMeta(db, "hold", holdFor(config));
      return { state: "needsAppUpdate" };
    }
    await applying(db, async (txn) => {
      for (const record of [...page.records].sort(byTableOrder(config))) await merge(ctx, txn, record);
      await setMeta(txn, "cursor", page.cursor);
    });
    cursor = page.cursor;
    if (!page.more) return undefined;
  }
}

/** The dirty rows as records, parents first. Dirty entries that cannot be pushed are dropped. */
async function dirtyRecords(ctx: Context): Promise<SyncRecord[]> {
  const { db, config } = ctx;
  await db.runAsync(
    `DELETE FROM _sync_changes WHERE table_name NOT IN (${config.tables.map(() => "?").join(", ")})`,
    config.tables.map((table) => table.name),
  );
  const records: SyncRecord[] = [];
  for (const table of ctx.tables.values()) {
    const t = quote(table.name);
    const k = quote(table.key);
    const pushable = `SELECT ${k} FROM ${t} WHERE updated_at > 0 AND ${notExcluded(table, k)}`;
    await db.runAsync(`DELETE FROM _sync_changes WHERE table_name = ? AND row_id NOT IN (${pushable})`, table.name);
    const rows = await db.getAllAsync<Row & { _sync_sys: string | null }>(
      `SELECT ${t}.*, r.sys AS _sync_sys FROM ${t}
       JOIN _sync_changes c ON c.table_name = ? AND c.row_id = ${t}.${k}
       LEFT JOIN _sync_rows r ON r.table_name = ? AND r.row_id = ${t}.${k}`,
      table.name,
      table.name,
    );
    for (const { _sync_sys: sys, ...row } of rows) {
      records.push({
        table: table.name,
        id: String(row[table.key]),
        updatedAt: Number(row.updated_at),
        schemaVersion: config.schemaVersion,
        payload: payloadOf(row),
        ...(sys == null ? {} : { sys }),
      });
    }
  }
  return records;
}

/** Pushes the dirty set, up to three rounds while conflicts leave rows to resend. */
async function push(ctx: Context, transport: Transport, deviceId: string): Promise<Stop | undefined> {
  const { db, config } = ctx;
  const context = { deviceId, app: config.app, schemaVersion: config.schemaVersion };
  for (let round = 0; round < PUSH_ROUNDS; round++) {
    const records = await dirtyRecords(ctx);
    if (!records.length) return undefined;
    let resend = false;
    for (let start = 0; start < records.length; start += PUSH_BATCH) {
      const batch = records.slice(start, start + PUSH_BATCH);
      const sent = new Map(batch.map((record) => [`${record.table}/${record.id}`, record]));
      const results = await transport.push(batch, context);
      let stop: Stop | undefined;
      await applying(db, async (txn) => {
        for (const result of results) {
          const record = sent.get(`${result.table}/${result.id}`);
          const table = ctx.tables.get(result.table);
          if (!record || !table) continue;
          if (result.result === "saved") {
            await storeSys(txn, result, result.sys);
            // A row edited again while it was in flight stays dirty.
            await txn.runAsync(
              `DELETE FROM _sync_changes WHERE table_name = ? AND row_id = ?
               AND (SELECT updated_at FROM ${quote(table.name)} WHERE ${quote(table.key)} = ?) = ?`,
              result.table,
              result.id,
              result.id,
              record.updatedAt,
            );
          } else if (result.result === "conflict") {
            const verdict = decide(await localRow(txn, table, result.id), result.server);
            if (verdict === "apply") await applyRecord(ctx, txn, table, result.server);
            if (verdict === "keep") resend = true;
            else await txn.runAsync("DELETE FROM _sync_changes WHERE table_name = ? AND row_id = ?", result.table, result.id);
            await storeSys(txn, result, result.server.sys);
          } else if (result.reason === "quota") {
            stop = { state: "quotaExceeded" };
          } else if (result.reason === "retry") {
            stop ??= { state: "idle", retry: true, retryAfterMs: result.retryAfterMs };
          } else {
            stop ??= { state: "error", error: `cloud-sync: the cloud refused ${result.table}/${result.id}` };
          }
        }
      });
      if (stop) return stop;
    }
    if (!resend) return undefined;
  }
  return undefined;
}

/**
 * One sync cycle: check the account, pull every page and merge it, push the dirty set.
 * Never throws for a cloud error; the result carries the state to show.
 */
export async function runCycle(
  db: SQLiteDatabase,
  config: SyncConfig,
  transport: Transport,
  options: CycleOptions = {},
): Promise<CycleResult> {
  const ctx: Context = {
    db,
    config,
    tables: new Map(config.tables.map((table) => [table.name, resolveTable(table)])),
    columns: new Map(),
    applied: new Set(),
  };
  const result = (stop: Stop, account?: Account): CycleResult => ({ ...stop, applied: [...ctx.applied], account });

  if ((await getMeta(db, "enabled")) === "0") return result({ state: "off" });
  const hold = await getMeta(db, "hold");
  if (hold === holdFor(config)) return result({ state: "needsAppUpdate" });
  if (hold) await deleteMeta(db, "hold");

  let account: Account | undefined;
  try {
    account = await transport.account();
    if (account.state === "none") return result({ state: "signedOut" }, account);
    if (account.state === "restricted") return result({ state: "unavailable" }, account);
    const stored = await getMeta(db, "account_id");
    if (account.id && stored && stored !== account.id) return result({ state: "accountChanged" }, account);
    if (account.id && !stored) await setMeta(db, "account_id", account.id);

    for (const table of ctx.tables.values()) ctx.columns.set(table.name, await columnsOf(db, table.name));

    const pulled = await pull(ctx, transport);
    if (pulled) return result(pulled, account);
    const pushed = options.pushPaused ? { state: "quotaExceeded" as const } : await push(ctx, transport, (await getMeta(db, "device_id")) ?? "");
    if (pushed) return result(pushed, account);
    await setMeta(db, "last_synced_at", String((options.now ?? Date.now)()));
    return result({ state: "idle" }, account);
  } catch (error) {
    return { ...result({ state: "error" }, account), error: error instanceof Error ? error.message : String(error) };
  }
}
