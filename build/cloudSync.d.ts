import type { SQLiteDatabase } from "expo-sqlite";
import type { CloudSync, SyncConfig, Transport } from "./types";
/** What the sync needs from the platform; `create.ts` wires React Native's AppState, tests pass fakes. */
export type SyncEnvironment = {
    appState?: {
        current: () => string;
        listen: (listener: (state: string) => void) => () => void;
    };
    /** How often to look for local writes while active. */
    writePollMs?: number;
    /** A periodic cycle while active (Android has no push). */
    foregroundPollMs?: number;
    now?: () => number;
};
/**
 * The sync for one database. Without a transport (a platform not built yet) it only reports `unavailable`.
 * Call `installSync` before creating it.
 */
export declare function createCloudSyncWith(db: SQLiteDatabase, config: SyncConfig, transport: Transport | undefined, env?: SyncEnvironment): CloudSync;
