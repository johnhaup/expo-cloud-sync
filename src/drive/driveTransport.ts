import type { Account, PushContext, PushResult, SyncRecord, Transport } from "../types";
import { driveApi, DriveError, type DriveApiOptions, type DriveFile } from "./driveApi";

/**
 * Android's cloud: the app's hidden appDataFolder on the user's Google Drive. Drive has no conditional update,
 * so no file has two writers: each device writes two files of its own, a base snapshot and a delta, holding
 * the records that device pushed. Readers merge every other device's files record by record (newest wins), so
 * the order files are read in, or reading a base and delta mid-write, cannot change the outcome.
 *
 * Names: `<app>.<deviceId>.base.json` and `<app>.<deviceId>.delta.json` (the app prefix keeps apps apart if two
 * ever share a Google Cloud project). The cursor is JSON `{ files: { [fileId]: version }, own?: baseFileId }`.
 */
export type DriveTransportOptions = DriveApiOptions & {
  app: string;
  /** This install's id (`_sync_meta.device_id`): its files are skipped on pull. */
  deviceId: () => Promise<string>;
  now?: () => number;
};

/** A delta above this many rows, or above a fifth of all of this device's rows, is folded into the base. */
export const COMPACT_ROWS = 200;
export const FILE_FORMAT = 1;

type Kind = "base" | "delta";
export type DriveFileBody = { format: number; app: string; schemaVersion: number; deviceId: string; writtenAt: number; records: SyncRecord[] };
type Cursor = { files: Record<string, string>; own?: string };

/** What this device has in Drive: only it writes these, so after one read the copy here stays true. */
type Own = { accountId?: string; ids: Partial<Record<Kind, string>>; base: Map<string, SyncRecord>; delta: Map<string, SyncRecord> };

const keyOf = (record: { table: string; id: string }) => `${record.table}/${record.id}`;
const stripped = ({ sys: _sys, ...record }: SyncRecord): SyncRecord => record;

export const fileName = (app: string, deviceId: string, kind: Kind) => `${app}.${deviceId}.${kind}.json`;

function parseName(app: string, name: string): { deviceId: string; kind: Kind } | undefined {
  const match = /^(.+)\.(base|delta)\.json$/.exec(name);
  if (!match || !match[1].startsWith(`${app}.`)) return undefined;
  return { deviceId: match[1].slice(app.length + 1), kind: match[2] as Kind };
}

const parseCursor = (cursor: string | null): Cursor => (cursor ? (JSON.parse(cursor) as Cursor) : { files: {} });

export function driveTransport(options: DriveTransportOptions): Transport {
  const { app, now = Date.now } = options;
  const api = driveApi(options);
  let known: { token: string; account: Account } | undefined;
  let own: Own | undefined;

  const appFiles = async () =>
    (await api.list()).flatMap((file) => {
      const parsed = parseName(app, file.name);
      return parsed ? [{ ...file, ...parsed }] : [];
    });

  async function read(file: DriveFile): Promise<SyncRecord[]> {
    let text: string;
    try {
      text = await api.download(file.id);
    } catch (error) {
      // Deleted between the list and the download: it is gone from the next list too.
      if (error instanceof DriveError && error.kind === "notFound") return [];
      throw error;
    }
    const body = JSON.parse(text) as DriveFileBody;
    if (body.format !== FILE_FORMAT) throw new Error(`cloud-sync: ${file.name} has file format ${body.format}; update the app`);
    return body.records.map(stripped);
  }

  /** This device's files, read once per account and kept in memory after that. */
  async function loadOwn(deviceId: string): Promise<Own> {
    if (own) return own;
    const mine = (await appFiles()).filter((file) => file.deviceId === deviceId);
    const loaded: Own = { accountId: known?.account.id, ids: {}, base: new Map(), delta: new Map() };
    for (const kind of ["base", "delta"] as const) {
      const file = mine.find((candidate) => candidate.kind === kind);
      if (!file) continue;
      loaded.ids[kind] = file.id;
      for (const record of await read(file)) loaded[kind].set(keyOf(record), record);
    }
    return (own = loaded);
  }

  async function writeFile(state: Own, kind: Kind, records: Map<string, SyncRecord>, context: PushContext) {
    const body: DriveFileBody = {
      format: FILE_FORMAT,
      app,
      schemaVersion: context.schemaVersion,
      deviceId: context.deviceId,
      writtenAt: now(),
      records: [...records.values()],
    };
    state.ids[kind] = (await api.upload(fileName(app, context.deviceId, kind), JSON.stringify(body), state.ids[kind])).id;
  }

  /**
   * Writes the delta, or folds it into the base: base first, then an empty delta, so a reader in between sees
   * every record at least once. A missing base (first push, or the user deleted the app's Drive data) is written
   * first. An own file that is gone (404) is written again from scratch.
   */
  async function write(state: Own, context: PushContext, retried = false): Promise<void> {
    const total = new Set([...state.base.keys(), ...state.delta.keys()]).size;
    const compact = !state.ids.base || state.delta.size > COMPACT_ROWS || state.delta.size * 5 > total;
    try {
      if (!compact) return await writeFile(state, "delta", state.delta, context);
      const merged = new Map([...state.base, ...state.delta]);
      await writeFile(state, "base", merged, context);
      state.base = merged;
      state.delta = new Map();
      await writeFile(state, "delta", state.delta, context);
    } catch (error) {
      if (retried || !(error instanceof DriveError && error.kind === "notFound")) throw error;
      state.ids = {};
      await write(state, context, true);
    }
  }

  const unchanged = (state: Own, record: SyncRecord) => {
    const stored = state.delta.get(keyOf(record)) ?? state.base.get(keyOf(record));
    return stored?.updatedAt === record.updatedAt && stored.payload === record.payload && stored.schemaVersion === record.schemaVersion;
  };

  return {
    /** Asks for a token silently before every cycle (they last an hour); the account comes from Drive's `about`. */
    async account() {
      const token = await api.authorize(false);
      if (!token) {
        known = undefined;
        return { state: "none" };
      }
      if (known?.token !== token) {
        try {
          const user = await api.about();
          known = { token, account: { state: "available", id: user.permissionId, label: user.emailAddress } };
        } catch (error) {
          if (error instanceof DriveError && error.kind === "unauthorized") return { state: "none" };
          throw error;
        }
      }
      if (own && own.accountId !== known.account.id) own = undefined;
      return { ...known.account };
    },

    /** One other device's changed file per page. */
    async pull(cursorText) {
      const deviceId = await options.deviceId();
      const cursor = parseCursor(cursorText);
      const files = await appFiles();
      const exists = (id: string | undefined) => !!id && files.some((file) => file.id === id);
      // Our base was there and is gone: the app's Drive data was deleted. Start over and push everything again.
      if (cursor.own && !exists(cursor.own)) {
        own = undefined;
        return { records: [], cursor: "", more: false, reset: true };
      }
      const others = files.filter((file) => file.deviceId !== deviceId).sort((a, b) => a.name.localeCompare(b.name));
      const next: Cursor = {
        files: Object.fromEntries(others.filter((file) => file.id in cursor.files).map((file) => [file.id, cursor.files[file.id]])),
        own: cursor.own ?? files.find((file) => file.deviceId === deviceId && file.kind === "base")?.id,
      };
      const changed = others.filter((file) => cursor.files[file.id] !== file.version);
      if (!changed.length) return { records: [], cursor: JSON.stringify(next), more: false };
      const [file] = changed;
      const records = await read(file);
      next.files[file.id] = file.version;
      return { records, cursor: JSON.stringify(next), more: changed.length > 1 };
    },

    async push(records, context) {
      try {
        const state = await loadOwn(context.deviceId);
        const changed = records.filter((record) => !unchanged(state, record));
        for (const record of changed) state.delta.set(keyOf(record), stripped(record));
        if (changed.length || !state.ids.base) await write(state, context);
        return records.map(({ table, id }): PushResult => ({ table, id, result: "saved" }));
      } catch (error) {
        // What is in memory may now be ahead of Drive: read it again next time.
        own = undefined;
        if (!(error instanceof DriveError) || (error.kind !== "quota" && error.kind !== "retry")) throw error;
        return records.map(({ table, id }): PushResult => ({ table, id, result: "failed", reason: error.kind as "quota" | "retry" }));
      }
    },

    /** "Delete synced copy": every file of this app in appDataFolder, from every device. */
    async wipe() {
      own = undefined;
      for (const file of await appFiles()) await api.remove(file.id);
    },

    async signIn() {
      known = undefined;
      return (await api.authorize(true)) !== null;
    },

    async signOut() {
      const email = known?.account.label ?? (await api.about().catch(() => undefined))?.emailAddress;
      own = undefined;
      known = undefined;
      api.forget();
      if (email) await options.auth.revoke(email);
    },
  };
}
