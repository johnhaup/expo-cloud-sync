import { type ConfigPlugin } from "expo/config-plugins";
export type CloudSyncPluginProps = {
    /** The CloudKit container. Default: `iCloud.<ios.bundleIdentifier>`. */
    iCloudContainer?: string;
    /** Extra Android Auto Backup includes (an app still keeping data in MMKV files). Ticket M6. */
    backupInclude?: {
        domain: string;
        path: string;
    }[];
};
declare const _default: ConfigPlugin<void | CloudSyncPluginProps>;
export default _default;
