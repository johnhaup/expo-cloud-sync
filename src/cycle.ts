import {
  accountGate,
  applying,
  createContext,
  dirtyRecords,
  endFresh,
  gate,
  holdForNewerSchema,
  mergeRecords,
  settleConflict,
  settleSaved,
  type Context,
} from "./apply";
import { beginFirstSync, getMeta, setMeta } from "./install";
import type { SQLiteDatabase } from "expo-sqlite";
import type { Account, SyncConfig, SyncState, Transport } from "./types";

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
    if (await holdForNewerSchema(ctx, page.records)) return { state: "needsAppUpdate" };
    await applying(db, async (txn) => {
      await mergeRecords(ctx, txn, page.records);
      await setMeta(txn, "cursor", page.cursor);
    });
    cursor = page.cursor;
    if (!page.more) return undefined;
  }
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
          if (!record || !ctx.tables.has(result.table)) continue;
          if (result.result === "saved") {
            await settleSaved(ctx, txn, { ...result, updatedAt: record.updatedAt });
          } else if (result.result === "conflict") {
            if (await settleConflict(ctx, txn, result.server)) resend = true;
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
 * One sync cycle (Android, and the memory cloud): check the account, pull every page and merge it, push the
 * dirty set. Never throws for a cloud error; the result carries the state to show. iOS runs `engineSync.ts`.
 */
export async function runCycle(
  db: SQLiteDatabase,
  config: SyncConfig,
  transport: Transport,
  options: CycleOptions = {},
): Promise<CycleResult> {
  let ctx: Context | undefined;
  const result = (stop: Stop, account?: Account): CycleResult => ({ ...stop, applied: [...(ctx?.applied ?? [])], account });

  const gated = await gate(db, config);
  if (gated) return result({ state: gated });

  let account: Account | undefined;
  try {
    account = await transport.account();
    const blocked = await accountGate(db, account);
    if (blocked) return result({ state: blocked }, account);

    ctx = await createContext(db, config);
    const pulled = await pull(ctx, transport);
    if (pulled) return result(pulled, account);
    await endFresh(db);
    const pushed = options.pushPaused ? { state: "quotaExceeded" as const } : await push(ctx, transport, (await getMeta(db, "device_id")) ?? "");
    if (pushed) return result(pushed, account);
    await setMeta(db, "last_synced_at", String((options.now ?? Date.now)()));
    return result({ state: "idle" }, account);
  } catch (error) {
    return { ...result({ state: "error" }, account), error: error instanceof Error ? error.message : String(error) };
  }
}
