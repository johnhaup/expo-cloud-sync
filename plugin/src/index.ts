import { type ConfigPlugin, createRunOncePlugin, withEntitlementsPlist, withInfoPlist } from "expo/config-plugins";

export type CloudSyncPluginProps = {
  /** The CloudKit container. Default: `iCloud.<ios.bundleIdentifier>`. */
  iCloudContainer?: string;
  /** Extra Android Auto Backup includes (an app still keeping data in MMKV files). Ticket M6. */
  backupInclude?: { domain: string; path: string }[];
};

const addUnique = (list: unknown, value: string) => {
  const values = Array.isArray(list) ? (list as string[]) : [];
  return values.includes(value) ? values : [...values, value];
};

/**
 * iOS: the iCloud container with CloudKit, push for CKSyncEngine's silent notifications, and
 * `CloudSyncContainer` in Info.plist for the native module. The app must target iOS 17.0
 * (`ios.deploymentTarget`). The Android half (Auto Backup rules) lands with ticket M6.
 */
const withCloudSync: ConfigPlugin<CloudSyncPluginProps | void> = (config, props) => {
  const container = props?.iCloudContainer ?? (config.ios?.bundleIdentifier ? `iCloud.${config.ios.bundleIdentifier}` : undefined);
  if (!container) throw new Error("@johnhaup/expo-cloud-sync: set ios.bundleIdentifier or the plugin's iCloudContainer");

  config = withEntitlementsPlist(config, (config) => {
    const entitlements = config.modResults;
    entitlements["com.apple.developer.icloud-container-identifiers"] = addUnique(entitlements["com.apple.developer.icloud-container-identifiers"], container);
    entitlements["com.apple.developer.icloud-services"] = addUnique(entitlements["com.apple.developer.icloud-services"], "CloudKit");
    // CKSyncEngine's pushes need it; signing swaps it for "production" in distribution builds. A plugin that
    // runs later and removes it (check expo-notifications' enableRemoteNotifications: false) stops the pushes.
    entitlements["aps-environment"] ??= "development";
    return config;
  });

  return withInfoPlist(config, (config) => {
    config.modResults.UIBackgroundModes = addUnique(config.modResults.UIBackgroundModes, "remote-notification");
    config.modResults.CloudSyncContainer = container;
    return config;
  });
};

export default createRunOncePlugin(withCloudSync, "@johnhaup/expo-cloud-sync", "0.2.0");
