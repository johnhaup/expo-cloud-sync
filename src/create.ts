import type { SQLiteDatabase } from "expo-sqlite";
import { AppState, Platform, Settings } from "react-native";

import { createCloudSyncWith, type SyncEnvironment } from "./cloudSync";
import { createEngineSyncWith } from "./engineSync";
import { installSyncWith } from "./install";
import { getDeviceIdAsync, nativeSyncEngine } from "./native";
import { createMemoryCloud, memoryTransport } from "./testing/memoryTransport";
import type { CloudSync, SyncConfig, Transport } from "./types";

/** iOS launch argument (`-cloudSyncMock YES`) that swaps the cloud for an in-memory one with a signed-in account. */
export const CLOUD_SYNC_MOCK_FLAG = "cloudSyncMock";

const isFlagOn = (value: unknown) =>
  typeof value === "string" ? !["0", "false", "no", "off"].includes(value.trim().toLowerCase()) : Boolean(value);

/**
 * iOS launch arguments land in NSUserDefaults' argument domain, which React Native's `Settings` reads. Only a
 * developer tool can pass them (simctl, Maestro), so Maestro flows can open the Sync section with no account.
 */
const isMockLaunch = () => Platform.OS === "ios" && isFlagOn(Settings.get(CLOUD_SYNC_MOCK_FLAG));

let mockCloud: ReturnType<typeof createMemoryCloud> | undefined;

/** Creates the _sync tables and triggers and runs restore detection. Call after migrate(), before the first read. */
export async function installSync(db: SQLiteDatabase, config: SyncConfig, options: { deviceId?: string } = {}) {
  await installSyncWith(db, config, options.deviceId ?? (await getDeviceIdAsync()));
}

/**
 * The sync for one database: CKSyncEngine on iOS, the pull/push cycle over `transport` otherwise (the memory
 * cloud with `-cloudSyncMock` or a passed transport; Google Drive lands with ticket M5).
 */
export function createCloudSync(db: SQLiteDatabase, config: SyncConfig, transport?: Transport): CloudSync {
  const env: SyncEnvironment = {
    appState: {
      current: () => String(AppState.currentState),
      listen: (listener) => {
        const subscription = AppState.addEventListener("change", listener);
        return () => subscription.remove();
      },
    },
    foregroundPollMs: Platform.OS === "android" ? 60_000 : undefined,
  };
  if (isMockLaunch()) transport ??= memoryTransport((mockCloud ??= createMemoryCloud()));
  if (!transport && Platform.OS === "ios") return createEngineSyncWith(db, config, nativeSyncEngine(), env);
  return createCloudSyncWith(db, config, transport, env);
}
