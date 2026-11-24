import { AppState, Platform, Settings } from "react-native";
import { createCloudSyncWith } from "./cloudSync";
import { installSyncWith } from "./install";
import { getDeviceIdAsync } from "./native";
import { createMemoryCloud, memoryTransport } from "./testing/memoryTransport";
/** iOS launch argument (`-cloudSyncMock YES`) that swaps the cloud for an in-memory one with a signed-in account. */
export const CLOUD_SYNC_MOCK_FLAG = "cloudSyncMock";
const isFlagOn = (value) => typeof value === "string" ? !["0", "false", "no", "off"].includes(value.trim().toLowerCase()) : Boolean(value);
/**
 * iOS launch arguments land in NSUserDefaults' argument domain, which React Native's `Settings` reads. Only a
 * developer tool can pass them (simctl, Maestro), so Maestro flows can open the Sync section with no account.
 */
const isMockLaunch = () => Platform.OS === "ios" && isFlagOn(Settings.get(CLOUD_SYNC_MOCK_FLAG));
let mockCloud;
/** The platform's transport: CloudKit (ticket M4) and Google Drive (ticket M5) are not built yet. */
const platformTransport = () => {
    if (isMockLaunch())
        return memoryTransport((mockCloud ??= createMemoryCloud()));
    return undefined;
};
/** Creates the _sync tables and triggers and runs restore detection. Call after migrate(), before the first read. */
export async function installSync(db, config, options = {}) {
    await installSyncWith(db, config, options.deviceId ?? (await getDeviceIdAsync()));
}
export function createCloudSync(db, config, transport) {
    return createCloudSyncWith(db, config, transport ?? platformTransport(), {
        appState: {
            current: () => String(AppState.currentState),
            listen: (listener) => {
                const subscription = AppState.addEventListener("change", listener);
                return () => subscription.remove();
            },
        },
        foregroundPollMs: Platform.OS === "android" ? 60_000 : undefined,
    });
}
