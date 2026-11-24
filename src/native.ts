import { NativeModule, requireNativeModule } from "expo";

import type { DriveAuth } from "./drive/driveApi";
import type { Account, EngineEvent, SyncEngine, SyncRecord } from "./types";

declare class CloudSyncNative extends NativeModule<{ onEngineEvent: (event: EngineEvent) => void }> {
  /** This install's id, kept where no backup reaches. */
  deviceIdAsync(): Promise<string>;
  // iOS only: the CKSyncEngine host (ios/CloudSyncEngine.swift).
  accountAsync(): Promise<Account>;
  startAsync(state: string | null, pending: SyncRecord[]): Promise<void>;
  enqueueAsync(records: SyncRecord[]): Promise<void>;
  syncAsync(): Promise<void>;
  stopAsync(): Promise<void>;
  wipeAsync(): Promise<void>;
  // Android only: Google authorization for drive.appdata.
  authorizeAsync(interactive: boolean): Promise<string | null>;
  clearTokenAsync(token: string): Promise<void>;
  revokeAccessAsync(email: string): Promise<void>;
}

let native: CloudSyncNative | undefined;

/** Loaded on first use, so importing the package does not need the native module (tests, web). */
export const cloudSyncNative = () => (native ??= requireNativeModule<CloudSyncNative>("CloudSync"));

export const getDeviceIdAsync = () => cloudSyncNative().deviceIdAsync();

/** iOS: CKSyncEngine in the module's native code. */
export function nativeSyncEngine(): SyncEngine {
  const module = cloudSyncNative();
  return {
    account: () => module.accountAsync(),
    start: (state, pending) => module.startAsync(state, pending),
    enqueue: (records) => module.enqueueAsync(records),
    sync: () => module.syncAsync(),
    stop: () => module.stopAsync(),
    wipe: () => module.wipeAsync(),
    addListener(listener) {
      const subscription = module.addListener("onEngineEvent", listener);
      return () => subscription.remove();
    },
  };
}

/** Android: AuthorizationClient (drive.appdata) in the module's native code. */
export function nativeGoogleAuth(): DriveAuth {
  const module = cloudSyncNative();
  return {
    token: (interactive) => module.authorizeAsync(interactive),
    clearToken: (token) => module.clearTokenAsync(token),
    revoke: (email) => module.revokeAccessAsync(email),
  };
}
