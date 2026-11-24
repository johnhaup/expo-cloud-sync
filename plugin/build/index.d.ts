import { type ConfigPlugin } from "expo/config-plugins";
/** An Auto Backup include: `domain` is one of Android's (`file`, `database`, `sharedpref`, `root`, `external`, ...). */
export type BackupInclude = {
    domain: string;
    path: string;
};
export type CloudSyncPluginProps = {
    /** The CloudKit container. Default: `iCloud.<ios.bundleIdentifier>`. */
    iCloudContainer?: string;
    /**
     * Extra Android Auto Backup includes, for app data that does not live in expo-sqlite's `files/SQLite/`
     * (MMKV: `{ domain: "file", path: "mmkv/" }`; AsyncStorage: `{ domain: "database", path: "RKStorage" }`).
     */
    backupInclude?: BackupInclude[];
};
declare const _default: ConfigPlugin<void | CloudSyncPluginProps>;
export default _default;
