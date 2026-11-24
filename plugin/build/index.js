"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const config_plugins_1 = require("expo/config-plugins");
const addUnique = (list, value) => {
    const values = Array.isArray(list) ? list : [];
    return values.includes(value) ? values : [...values, value];
};
/** expo-sqlite keeps every database (and its -wal file) in `filesDir/SQLite`. */
const SQLITE = { domain: "file", path: "SQLite/" };
const EXTRACTION_RULES = "cloud_sync_extraction_rules";
const BACKUP_CONTENT = "cloud_sync_backup_content";
const attribute = (value) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
const includes = (list, indent) => list.map(({ domain, path }) => `${indent}<include domain="${attribute(domain)}" path="${attribute(path)}"/>`).join("\n");
/** Android 12 and up: what goes to Google's cloud backup and to a device-to-device transfer. */
const extractionRules = (list) => `<?xml version="1.0" encoding="utf-8"?>
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
const backupContent = (list) => `<?xml version="1.0" encoding="utf-8"?>
<!-- Written by @johnhaup/expo-cloud-sync. -->
<full-backup-content>
${includes(list, "  ")}
</full-backup-content>
`;
/**
 * Android: Auto Backup stays on for everyone, signed in to Google or not, and holds the app's SQLite databases.
 * The device id lives in `noBackupFilesDir`, which no backup includes, so a restored install is noticed.
 */
const withAndroidBackup = (config, extra) => {
    const list = [SQLITE, ...extra.filter((item) => item.domain !== SQLITE.domain || item.path !== SQLITE.path)];
    config = (0, config_plugins_1.withAndroidManifest)(config, (config) => {
        const application = config.modResults.manifest.application?.[0];
        if (!application)
            throw new Error("@johnhaup/expo-cloud-sync: AndroidManifest.xml has no <application>");
        for (const [key, file] of [
            ["android:dataExtractionRules", EXTRACTION_RULES],
            ["android:fullBackupContent", BACKUP_CONTENT],
        ]) {
            const value = `@xml/${file}`;
            const existing = application.$[key];
            // Another plugin's rules (expo-secure-store writes its own) would be dropped silently: make the app decide.
            if (existing && existing !== value) {
                throw new Error(`@johnhaup/expo-cloud-sync: ${key} is already ${existing}. Merge its rules into the plugin's backupInclude and turn the other plugin's backup rules off.`);
            }
            application.$[key] = value;
        }
        return config;
    });
    return (0, config_plugins_1.withDangerousMod)(config, [
        "android",
        (config) => {
            const directory = node_path_1.default.join(config.modRequest.platformProjectRoot, "app", "src", "main", "res", "xml");
            node_fs_1.default.mkdirSync(directory, { recursive: true });
            node_fs_1.default.writeFileSync(node_path_1.default.join(directory, `${EXTRACTION_RULES}.xml`), extractionRules(list));
            node_fs_1.default.writeFileSync(node_path_1.default.join(directory, `${BACKUP_CONTENT}.xml`), backupContent(list));
            return config;
        },
    ]);
};
/**
 * iOS: the iCloud container with CloudKit, push for CKSyncEngine's silent notifications, and
 * `CloudSyncContainer` in Info.plist for the native module. The app must target iOS 17.0
 * (`ios.deploymentTarget`). Android: the Auto Backup rules.
 */
const withCloudSync = (config, props) => {
    const container = props?.iCloudContainer ?? (config.ios?.bundleIdentifier ? `iCloud.${config.ios.bundleIdentifier}` : undefined);
    if (!container)
        throw new Error("@johnhaup/expo-cloud-sync: set ios.bundleIdentifier or the plugin's iCloudContainer");
    config = (0, config_plugins_1.withEntitlementsPlist)(config, (config) => {
        const entitlements = config.modResults;
        entitlements["com.apple.developer.icloud-container-identifiers"] = addUnique(entitlements["com.apple.developer.icloud-container-identifiers"], container);
        entitlements["com.apple.developer.icloud-services"] = addUnique(entitlements["com.apple.developer.icloud-services"], "CloudKit");
        // CKSyncEngine's pushes need it; signing swaps it for "production" in distribution builds. A plugin that
        // runs later and removes it (check expo-notifications' enableRemoteNotifications: false) stops the pushes.
        entitlements["aps-environment"] ??= "development";
        return config;
    });
    config = (0, config_plugins_1.withInfoPlist)(config, (config) => {
        config.modResults.UIBackgroundModes = addUnique(config.modResults.UIBackgroundModes, "remote-notification");
        config.modResults.CloudSyncContainer = container;
        return config;
    });
    return withAndroidBackup(config, props?.backupInclude ?? []);
};
exports.default = (0, config_plugins_1.createRunOncePlugin)(withCloudSync, "@johnhaup/expo-cloud-sync", "0.4.0");
