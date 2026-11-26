import type { SyncRecord, Transport } from "../types";
import { type DriveApiOptions } from "./driveApi";
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
export declare const COMPACT_ROWS = 200;
/** How long sign out waits for Google to revoke the grant before going on without it. */
export declare const REVOKE_WAIT_MS = 5000;
export declare const FILE_FORMAT = 1;
type Kind = "base" | "delta";
export type DriveFileBody = {
    format: number;
    app: string;
    schemaVersion: number;
    deviceId: string;
    writtenAt: number;
    records: SyncRecord[];
};
export declare const fileName: (app: string, deviceId: string, kind: Kind) => string;
export declare function driveTransport(options: DriveTransportOptions): Transport;
export {};
