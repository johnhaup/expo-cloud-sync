import fs from "node:fs";
import path from "node:path";

import {
  type ConfigPlugin,
  createRunOncePlugin,
  withAndroidManifest,
  withDangerousMod,
  withEntitlementsPlist,
  withInfoPlist,
} from "expo/config-plugins";

/** An Auto Backup include: `domain` is one of Android's (`file`, `database`, `sharedpref`, `root`, `external`, ...). */
export type BackupInclude = { domain: string; path: string };

export type CloudSyncPluginProps = {
  /** The CloudKit container. Default: `iCloud.<ios.bundleIdentifier>`. */
  iCloudContainer?: string;
  /**
   * Extra Android Auto Backup includes, for app data that does not live in expo-sqlite's `files/SQLite/`
   * (MMKV: `{ domain: "file", path: "mmkv/" }`; AsyncStorage: `{ domain: "database", path: "RKStorage" }`).
   */
  backupInclude?: BackupInclude[];
};

const addUnique = (list: unknown, value: string) => {
  const values = Array.isArray(list) ? (list as string[]) : [];
  return values.includes(value) ? values : [...values, value];
};

/** expo-sqlite keeps every database (and its -wal file) in `filesDir/SQLite`. */
const SQLITE: BackupInclude = { domain: "file", path: "SQLite/" };
const EXTRACTION_RULES = "cloud_sync_extraction_rules";
const BACKUP_CONTENT = "cloud_sync_backup_content";

const attribute = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
const includes = (list: BackupInclude[], indent: string) =>
  list.map(({ domain, path }) => `${indent}<include domain="${attribute(domain)}" path="${attribute(path)}"/>`).join("\n");

/** Android 12 and up: what goes to Google's cloud backup and to a device-to-device transfer. */
const extractionRules = (list: BackupInclude[]) => `<?xml version="1.0" encoding="utf-8"?>
<!-- Written by @johnhaup/expo-cloud-sync. An include turns off "back up everything": caches stay out of the 25 MB cap. -->
<data-extraction-rules>
  <cloud-backup>
${includes(list, "    ")}
  </cloud-backup>
  <device-transfer>
${includes(list, "    ")}
  </device-transfer>
</data-extraction-rules>
`;

/** Android 11 and lower. */
const backupContent = (list: BackupInclude[]) => `<?xml version="1.0" encoding="utf-8"?>
<!-- Written by @johnhaup/expo-cloud-sync. -->
<full-backup-content>
${includes(list, "  ")}
</full-backup-content>
`;

/**
 * Android: Auto Backup stays on for everyone, signed in to Google or not, and holds the app's SQLite databases.
 * The device id lives in `noBackupFilesDir`, which no backup includes, so a restored install is noticed.
 */
const withAndroidBackup: ConfigPlugin<BackupInclude[]> = (config, extra) => {
  const list = [SQLITE, ...extra.filter((item) => item.domain !== SQLITE.domain || item.path !== SQLITE.path)];

  config = withAndroidManifest(config, (config) => {
    const application = config.modResults.manifest.application?.[0];
    if (!application) throw new Error("@johnhaup/expo-cloud-sync: AndroidManifest.xml has no <application>");
    for (const [key, file] of [
      ["android:dataExtractionRules", EXTRACTION_RULES],
      ["android:fullBackupContent", BACKUP_CONTENT],
    ] as const) {
      const value = `@xml/${file}`;
      const existing = application.$[key];
      // Another plugin's rules (expo-secure-store writes its own) would be dropped silently: make the app decide.
      if (existing && existing !== value) {
        throw new Error(
          `@johnhaup/expo-cloud-sync: ${key} is already ${existing}. Merge its rules into the plugin's backupInclude and turn the other plugin's backup rules off.`,
        );
      }
      application.$[key] = value;
    }
    return config;
  });

  return withDangerousMod(config, [
    "android",
    (config) => {
      const directory = path.join(config.modRequest.platformProjectRoot, "app", "src", "main", "res", "xml");
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, `${EXTRACTION_RULES}.xml`), extractionRules(list));
      fs.writeFileSync(path.join(directory, `${BACKUP_CONTENT}.xml`), backupContent(list));
      return config;
    },
  ]);
};

/**
 * iOS: the iCloud container with CloudKit, push for CKSyncEngine's silent notifications, and
 * `CloudSyncContainer` in Info.plist for the native module. The app must target iOS 17.0
 * (`ios.deploymentTarget`). Android: the Auto Backup rules.
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

  config = withInfoPlist(config, (config) => {
    config.modResults.UIBackgroundModes = addUnique(config.modResults.UIBackgroundModes, "remote-notification");
    config.modResults.CloudSyncContainer = container;
    return config;
  });

  return withAndroidBackup(config, props?.backupInclude ?? []);
};

export default createRunOncePlugin(withCloudSync, "@johnhaup/expo-cloud-sync", "0.4.0");
