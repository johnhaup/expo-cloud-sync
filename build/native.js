import { requireNativeModule } from "expo";
let native;
/** Loaded on first use, so importing the package does not need the native module (tests, web). */
export const cloudSyncNative = () => (native ??= requireNativeModule("CloudSync"));
export const getDeviceIdAsync = () => cloudSyncNative().deviceIdAsync();
