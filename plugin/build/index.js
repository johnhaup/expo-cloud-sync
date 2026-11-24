"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const config_plugins_1 = require("expo/config-plugins");
/**
 * Skeleton (HAU-760 M1). The iOS half (iCloud entitlements, `remote-notification`, `CloudSyncContainer`
 * in Info.plist) lands with ticket M4, the Android half (Auto Backup rules) with M6.
 */
const withCloudSync = (config) => config;
exports.default = (0, config_plugins_1.createRunOncePlugin)(withCloudSync, "@johnhaup/expo-cloud-sync", "0.1.0");
