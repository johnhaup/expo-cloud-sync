import { requireNativeModule } from "expo";

type CloudSyncNative = {
  /** This install's id, kept where no backup reaches. */
  deviceIdAsync(): Promise<string>;
};

let native: CloudSyncNative | undefined;

/** Loaded on first use, so importing the package does not need the native module (tests, web). */
export const cloudSyncNative = () => (native ??= requireNativeModule<CloudSyncNative>("CloudSync"));

export const getDeviceIdAsync = () => cloudSyncNative().deviceIdAsync();
