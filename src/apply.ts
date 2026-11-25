import type { SQLiteBindValue, SQLiteDatabase } from "expo-sqlite";

import { columnsOf, deleteMeta, getMeta, notExcluded, quote, resolveTable, setMeta, type Table } from "./install";
import { decide, payloadOf, type Row } from "./merge";
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

export async function createContext(db: SQLiteDatabase, config: SyncConfig): Promise<Context> {
  const tables = new Map(config.tables.map((table) => [table.name, resolveTable(table)]));
  const columns = new Map<string, string[]>();
  for (const table of tables.values()) columns.set(table.name, await columnsOf(db, table.name));
  return { db, config, tables, columns, applied: new Set() };
}

export const holdFor = (config: SyncConfig) => `needsAppUpdate@${config.schemaVersion}`;

/** Why sync cannot run right now, before any account check: off, or held for an app update. */
export async function gate(db: SQLiteDatabase, config: SyncConfig): Promise<"off" | "needsAppUpdate" | undefined> {
  if ((await getMeta(db, "enabled")) === "0") return "off";
  const hold = await getMeta(db, "hold");
  if (hold === holdFor(config)) return "needsAppUpdate";
  if (hold) await deleteMeta(db, "hold");
  return undefined;
}

/** The state an account puts sync in, or undefined when it may run. Stores the first account seen. */
export async function accountGate(db: SQLiteDatabase, account: Account): Promise<SyncState | undefined> {
  if (account.state === "none") return "signedOut";
  if (account.state === "restricted") return "unavailable";
  const stored = await getMeta(db, "account_id");
  if (account.id && stored && stored !== account.id) return "accountChanged";
  if (account.id && !stored) await setMeta(db, "account_id", account.id);
  return undefined;
}

/**
 * A record from a newer app version stops everything before it is applied: an old app would strip the new
 * columns and push the row back. Sets the hold and returns true when `records` holds one.
 */
export async function holdForNewerSchema(ctx: Context, records: SyncRecord[]) {
  if (!records.some((record) => record.schemaVersion > ctx.config.schemaVersion)) return false;
  await setMeta(ctx.db, "hold", holdFor(ctx.config));
  return true;
}

/** Runs `task` in an exclusive transaction with the triggers silenced and foreign keys checked at commit. */
export async function applying(db: SQLiteDatabase, task: (txn: SQLiteDatabase) => Promise<void>) {
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

const clean = (txn: SQLiteDatabase, table: string, id: string) =>
  txn.runAsync("DELETE FROM _sync_changes WHERE table_name = ? AND row_id = ?", table, id);

const byTableOrder = (config: SyncConfig) => {
  const order = new Map(config.tables.map((table, index) => [table.name, index]));
  return (a: SyncRecord, b: SyncRecord) => (order.get(a.table) ?? 0) - (order.get(b.table) ?? 0);
};

/** A new install whose first download has not finished: the cloud's rows win (`decide`). */
const isFresh = async (db: SQLiteDatabase) => (await getMeta(db, "fresh")) === "1";

/** The first download finished: from now on the newer row wins, as everywhere else. */
export const endFresh = (db: SQLiteDatabase) => deleteMeta(db, "fresh");

/** Merges fetched records (parents first) inside an `applying` transaction. */
export async function mergeRecords(ctx: Context, txn: SQLiteDatabase, records: SyncRecord[]) {
  const fresh = await isFresh(txn);
  for (const record of [...records].sort(byTableOrder(ctx.config))) {
    const table = ctx.tables.get(record.table);
    if (!table || table.excludeKeys.includes(record.id)) continue;
    const verdict = decide(await localRow(txn, table, record.id), record, fresh);
    if (verdict === "apply") await applyRecord(ctx, txn, table, record);
    // The local row won: it must reach the cloud even if it was not dirty. Otherwise it equals the cloud's.
    if (verdict === "keep") await markDirty(txn, table.name, record.id);
    else await clean(txn, table.name, record.id);
    await storeSys(txn, record, record.sys);
  }
}

/** A save went through: keep its change tag; the row stops being dirty unless it was edited again while in flight. */
export async function settleSaved(ctx: Context, txn: SQLiteDatabase, saved: { table: string; id: string; sys?: string; updatedAt: number }) {
  const table = ctx.tables.get(saved.table);
  if (!table) return;
  await storeSys(txn, saved, saved.sys);
  await txn.runAsync(
    `DELETE FROM _sync_changes WHERE table_name = ? AND row_id = ?
     AND (SELECT updated_at FROM ${quote(table.name)} WHERE ${quote(table.key)} = ?) = ?`,
    saved.table,
    saved.id,
    saved.id,
    saved.updatedAt,
  );
}

/**
 * The cloud holds a different version (CloudKit `serverRecordChanged`): `decide` against it. Returns true
 * when the local row won and must be sent again, now on top of the server's change tag.
 */
export async function settleConflict(ctx: Context, txn: SQLiteDatabase, server: SyncRecord) {
  const table = ctx.tables.get(server.table);
  if (!table) return false;
  const verdict = decide(await localRow(txn, table, server.id), server, await isFresh(txn));
  if (verdict === "apply") await applyRecord(ctx, txn, table, server);
  if (verdict !== "keep") await clean(txn, server.table, server.id);
  await storeSys(txn, server, server.sys);
  return verdict === "keep";
}

/** The dirty rows as records, parents first. Dirty entries that cannot be pushed are dropped. */
export async function dirtyRecords(ctx: Context): Promise<SyncRecord[]> {
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

export const countPending = async (db: SQLiteDatabase) =>
  (await db.getFirstAsync<{ count: number }>("SELECT COUNT(*) AS count FROM _sync_changes"))?.count ?? 0;
