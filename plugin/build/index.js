"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const config_plugins_1 = require("expo/config-plugins");
const addUnique = (list, value) => {
    const values = Array.isArray(list) ? list : [];
    return values.includes(value) ? values : [...values, value];
};
/**
 * iOS: the iCloud container with CloudKit, push for CKSyncEngine's silent notifications, and
 * `CloudSyncContainer` in Info.plist for the native module. The app must target iOS 17.0
 * (`ios.deploymentTarget`). The Android half (Auto Backup rules) lands with ticket M6.
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
    return (0, config_plugins_1.withInfoPlist)(config, (config) => {
        config.modResults.UIBackgroundModes = addUnique(config.modResults.UIBackgroundModes, "remote-notification");
        config.modResults.CloudSyncContainer = container;
        return config;
    });
};
exports.default = (0, config_plugins_1.createRunOncePlugin)(withCloudSync, "@johnhaup/expo-cloud-sync", "0.3.0");
