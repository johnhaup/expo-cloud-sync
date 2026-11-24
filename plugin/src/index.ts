import { type ConfigPlugin, createRunOncePlugin } from "expo/config-plugins";

export type CloudSyncPluginProps = {
  /** The CloudKit container. Default: `iCloud.<ios.bundleIdentifier>`. */
  iCloudContainer?: string;
  /** Extra Android Auto Backup includes (an app still keeping data in MMKV files). */
  backupInclude?: { domain: string; path: string }[];
};

/**
 * Skeleton (HAU-760 M1). The iOS half (iCloud entitlements, `remote-notification`, `CloudSyncContainer`
 * in Info.plist) lands with ticket M4, the Android half (Auto Backup rules) with M6.
 */
const withCloudSync: ConfigPlugin<CloudSyncPluginProps | void> = (config) => config;

export default createRunOncePlugin(withCloudSync, "@johnhaup/expo-cloud-sync", "0.1.0");
