import { type ReactNode } from "react";
import type { CloudSync, SyncConfig, SyncStatus, Transport } from "./types";
export type CloudSyncValue = SyncStatus & Pick<CloudSync, "syncNow" | "setEnabled" | "signIn" | "signOut" | "adoptAccount"> & {
    /** Goes up each time remote rows land; a screen that reads on focus adds it to its read's dependencies. */
    revision: number;
};
/**
 * Runs the sync for the surrounding `SQLiteProvider`'s database (call `installSync` in its `onInit`).
 * `transport` replaces the platform's, for tests and the example app.
 */
export declare function CloudSyncProvider({ config, transport, children }: {
    config: SyncConfig;
    transport?: Transport;
    children: ReactNode;
}): import("react").JSX.Element;
export declare function useCloudSync(): CloudSyncValue;
