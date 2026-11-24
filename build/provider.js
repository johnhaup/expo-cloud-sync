import { jsx as _jsx } from "react/jsx-runtime";
import { useSQLiteContext } from "expo-sqlite";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { createCloudSync } from "./create";
const CloudSyncContext = createContext(null);
/**
 * Runs the sync for the surrounding `SQLiteProvider`'s database (call `installSync` in its `onInit`).
 * `transport` replaces the platform's, for tests and the example app.
 */
export function CloudSyncProvider({ config, transport, children }) {
    const db = useSQLiteContext();
    // One sync per database: a new config object on each render must not restart it.
    const [sync] = useState(() => createCloudSync(db, config, transport));
    const [status, setStatus] = useState(sync.getStatus);
    const [revision, setRevision] = useState(0);
    useEffect(() => {
        const unsubscribe = sync.subscribe(setStatus);
        const unlisten = sync.onRemoteChange(() => setRevision((value) => value + 1));
        sync.start();
        return () => {
            unsubscribe();
            unlisten();
            sync.stop();
        };
    }, [sync]);
    const value = useMemo(() => ({
        ...status,
        revision,
        syncNow: sync.syncNow,
        setEnabled: sync.setEnabled,
        signIn: sync.signIn,
        signOut: sync.signOut,
        adoptAccount: sync.adoptAccount,
    }), [status, revision, sync]);
    return _jsx(CloudSyncContext.Provider, { value: value, children: children });
}
export function useCloudSync() {
    const value = useContext(CloudSyncContext);
    if (!value)
        throw new Error("cloud-sync: useCloudSync needs a CloudSyncProvider above it");
    return value;
}
