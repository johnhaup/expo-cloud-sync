import { NativeModule } from "expo";
import type { Account, EngineEvent, SyncEngine, SyncRecord } from "./types";
declare class CloudSyncNative extends NativeModule<{
    onEngineEvent: (event: EngineEvent) => void;
}> {
    /** This install's id, kept where no backup reaches. */
    deviceIdAsync(): Promise<string>;
    accountAsync(): Promise<Account>;
    startAsync(state: string | null, pending: SyncRecord[]): Promise<void>;
    enqueueAsync(records: SyncRecord[]): Promise<void>;
    syncAsync(): Promise<void>;
    stopAsync(): Promise<void>;
    wipeAsync(): Promise<void>;
}
/** Loaded on first use, so importing the package does not need the native module (tests, web). */
export declare const cloudSyncNative: () => CloudSyncNative;
export declare const getDeviceIdAsync: () => Promise<string>;
/** iOS: CKSyncEngine in the module's native code. */
export declare function nativeSyncEngine(): SyncEngine;
export {};
