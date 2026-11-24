type CloudSyncNative = {
    /** This install's id, kept where no backup reaches. */
    deviceIdAsync(): Promise<string>;
};
/** Loaded on first use, so importing the package does not need the native module (tests, web). */
export declare const cloudSyncNative: () => CloudSyncNative;
export declare const getDeviceIdAsync: () => Promise<string>;
export {};
