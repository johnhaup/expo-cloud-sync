import { requireNativeModule } from "expo";
let native;
/** Loaded on first use, so importing the package does not need the native module (tests, web). */
export const cloudSyncNative = () => (native ??= requireNativeModule("CloudSync"));
export const getDeviceIdAsync = () => cloudSyncNative().deviceIdAsync();
/** iOS: CKSyncEngine in the module's native code. */
export function nativeSyncEngine() {
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
