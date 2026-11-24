import {
  CloudSyncProvider,
  createMemoryCloud,
  getDeviceIdAsync,
  installSync,
  memoryTransport,
  type MemoryCloud,
  type SyncConfig,
  useCloudSync,
} from "@johnhaup/expo-cloud-sync";
import { SQLiteProvider, type SQLiteDatabase, useSQLiteContext } from "expo-sqlite";
import { StatusBar } from "expo-status-bar";
import { useEffect, useMemo, useState } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, useColorScheme, View } from "react-native";

const SCHEMA_VERSION = 1;

const CONFIG: SyncConfig = { app: "cloud-sync-example", schemaVersion: SCHEMA_VERSION, tables: [{ name: "notes" }] };

async function migrate(db: SQLiteDatabase) {
  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    );
  `);
}

/**
 * `SQLiteProvider` reruns `onInit` whenever its identity changes, on the same shared connection: an inline
 * function would run `installSync` twice at once on every re-render ("cannot start a transaction within a
 * transaction"). Keep them stable.
 */
const initPlatform = async (db: SQLiteDatabase) => {
  await migrate(db);
  await installSync(db, CONFIG);
};
const initDevice = {
  a: async (db: SQLiteDatabase) => {
    await migrate(db);
    await installSync(db, CONFIG, { deviceId: "example-a" });
  },
  b: async (db: SQLiteDatabase) => {
    await migrate(db);
    await installSync(db, CONFIG, { deviceId: "example-b" });
  },
};

const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

type Note = { id: string; body: string; updated_at: number };

const readNotes = (db: SQLiteDatabase) =>
  db.getAllAsync<Note>("SELECT id, body, updated_at FROM notes WHERE deleted_at IS NULL ORDER BY updated_at DESC");
const addNote = (db: SQLiteDatabase, body: string) =>
  db.runAsync("INSERT INTO notes (id, body, updated_at) VALUES (?, ?, ?)", newId(), body, Date.now());
const saveNote = (db: SQLiteDatabase, id: string, body: string) =>
  db.runAsync("UPDATE notes SET body = ?, updated_at = ? WHERE id = ?", body, Date.now(), id);
/** A tombstone: synced tables never hard-delete. */
const deleteNote = (db: SQLiteDatabase, id: string) => {
  const now = Date.now();
  return db.runAsync("UPDATE notes SET deleted_at = ?, updated_at = ? WHERE id = ?", now, now, id);
};

/** The cloud's knobs, changed outside render. */
const knobs = {
  setAccount: (cloud: MemoryCloud, account: MemoryCloud["account"]) => void (cloud.account = { ...account }),
  toggleQuota: (cloud: MemoryCloud) => void (cloud.quotaExceeded = !cloud.quotaExceeded),
  toggleFailure: (cloud: MemoryCloud) => void (cloud.failure = cloud.failure ? null : "The network is down"),
  askToRetry: (cloud: MemoryCloud) => void (cloud.retryNextPushMs = 5_000),
  /** A note from an app one schema version ahead: every device that pulls it holds with needsAppUpdate. */
  newerAppWrites: (cloud: MemoryCloud) => {
    const id = newId();
    const now = Date.now();
    cloud.put({
      table: "notes",
      id,
      updatedAt: now,
      schemaVersion: SCHEMA_VERSION + 1,
      payload: JSON.stringify({ body: "From a newer app", deleted_at: null, id, updated_at: now }),
    });
  },
};

/** The platform's own sync: CKSyncEngine on iOS, the Drive appDataFolder on Android. */
const PLATFORM_CLOUD = Platform.OS === "android" ? "Google Drive" : "iCloud";

/**
 * One database on the platform's real sync (iCloud through CKSyncEngine on iOS, Google Drive on Android), then two "devices" (two
 * databases in this process) syncing through one in-memory cloud, with switches that put the cloud into every
 * state the sync handles. The native device id shows the module is linked.
 */
export default function App() {
  const dark = useColorScheme() === "dark";
  const colors = dark ? DARK : LIGHT;
  const [deviceId, setDeviceId] = useState("…");
  const [cloud] = useState(() => createMemoryCloud());

  useEffect(() => {
    getDeviceIdAsync().then(setDeviceId, (error: Error) => setDeviceId(`error: ${error.message}`));
  }, []);

  return (
    <ScrollView style={{ backgroundColor: colors.background }} contentContainerStyle={styles.screen}>
      <StatusBar style="auto" />
      <Text style={[styles.title, { color: colors.text }]}>Cloud Sync Example</Text>
      <Text testID="device-id" style={{ color: colors.muted }} selectable>
        Device id: {deviceId}
      </Text>
      <SQLiteProvider databaseName="icloud.db" onInit={initPlatform}>
        {/* iOS needs the iCloud container and a signed-in account; Android a Google Cloud OAuth client and a sign-in. */}
        <CloudSyncProvider config={CONFIG}>
          <Notes name={PLATFORM_CLOUD} colors={colors} />
        </CloudSyncProvider>
      </SQLiteProvider>
      <CloudControls cloud={cloud} colors={colors} />
      {(["a", "b"] as const).map((name) => (
        <SQLiteProvider key={name} databaseName={`device-${name}.db`} onInit={initDevice[name]}>
          <Device name={name.toUpperCase()} cloud={cloud} colors={colors} />
        </SQLiteProvider>
      ))}
    </ScrollView>
  );
}

function CloudControls({ cloud, colors }: { cloud: MemoryCloud; colors: Colors }) {
  const [, rerender] = useState(0);
  const change = (update: () => void) => () => {
    update();
    rerender((value) => value + 1);
  };
  const accounts = [
    { label: "Signed in", account: { state: "available", id: "memory-account", label: "memory@example.com" } },
    { label: "Other account", account: { state: "available", id: "other-account", label: "other@example.com" } },
    { label: "Signed out", account: { state: "none" } },
    { label: "Restricted", account: { state: "restricted" } },
  ] as const;
  return (
    <View style={[styles.card, { backgroundColor: colors.card }]}>
      <Text style={[styles.heading, { color: colors.text }]}>Memory cloud ({cloud.records().length} records)</Text>
      <View style={styles.row}>
        {accounts.map(({ label, account }) => (
          <Button
            key={label}
            label={label}
            colors={colors}
            selected={cloud.account.state === account.state && cloud.account.id === ("id" in account ? account.id : undefined)}
            onPress={change(() => knobs.setAccount(cloud, account))}
          />
        ))}
      </View>
      <Toggle label="Storage full" value={cloud.quotaExceeded} colors={colors} onChange={change(() => knobs.toggleQuota(cloud))} />
      <Toggle label="Network down" value={cloud.failure !== null} colors={colors} onChange={change(() => knobs.toggleFailure(cloud))} />
      <View style={styles.row}>
        <Button label="Ask to retry" colors={colors} onPress={change(() => knobs.askToRetry(cloud))} />
        <Button label="Expire cursors" colors={colors} onPress={change(() => cloud.expireCursors())} />
        <Button label="Newer app writes" colors={colors} onPress={change(() => knobs.newerAppWrites(cloud))} />
      </View>
    </View>
  );
}

function Device({ name, cloud, colors }: { name: string; cloud: MemoryCloud; colors: Colors }) {
  const transport = useMemo(() => memoryTransport(cloud), [cloud]);
  return (
    <CloudSyncProvider config={CONFIG} transport={transport}>
      <Notes name={name} colors={colors} />
    </CloudSyncProvider>
  );
}

function Notes({ name, colors }: { name: string; colors: Colors }) {
  const db = useSQLiteContext();
  const sync = useCloudSync();
  const [notes, setNotes] = useState<Note[]>([]);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);

  // Bumped after each local write; `sync.revision` after each remote one.
  const [written, setWritten] = useState(0);

  useEffect(() => {
    let live = true;
    void readNotes(db).then((rows) => live && setNotes(rows));
    return () => {
      live = false;
    };
  }, [db, sync.revision, written]);

  const after = (write: Promise<unknown>) => void write.then(() => setWritten((value) => value + 1));
  const add = () => {
    if (!draft.trim()) return;
    after(addNote(db, draft.trim()));
    setDraft("");
  };
  const save = () => {
    if (!editing) return;
    after(saveNote(db, editing.id, editing.body));
    setEditing(null);
  };

  return (
    <View style={[styles.card, { backgroundColor: colors.card }]}>
      <Text style={[styles.heading, { color: colors.text }]}>{name.length > 1 ? name : `Device ${name}`}</Text>

      <View testID={`sync-${name}`} style={styles.sync}>
        <Text style={{ color: colors.text }}>
          Sync: <Text testID={`sync-state-${name}`}>{sync.state}</Text> · {sync.pending} pending
        </Text>
        {sync.accountLabel ? <Text style={{ color: colors.muted }}>Syncing as {sync.accountLabel}</Text> : null}
        {sync.lastSyncedAt ? <Text style={{ color: colors.muted }}>Last synced {new Date(sync.lastSyncedAt).toLocaleTimeString()}</Text> : null}
        {sync.error ? <Text style={{ color: colors.danger }}>{sync.error}</Text> : null}
        <Toggle label="Sync on" value={sync.state !== "off"} colors={colors} onChange={(on) => void sync.setEnabled(on)} />
        <Button label="Sync now" colors={colors} onPress={() => void sync.syncNow()} />
        {sync.state === "accountChanged" ? (
          // Nothing syncs until the user answers; "Not now" just leaves it waiting.
          <View testID={`account-changed-${name}`} style={styles.sync}>
            <Text style={{ color: colors.text }}>
              {sync.accountLabel ? `Merge this phone's data into ${sync.accountLabel}?` : "Merge this phone's data into this iCloud account?"}
            </Text>
            <Button label="Merge" colors={colors} onPress={() => void sync.adoptAccount()} />
          </View>
        ) : null}
        {name === "Google Drive" ? (
          <View style={styles.row}>
            {sync.state === "signedOut" ? (
              <Button label="Sign in with Google" colors={colors} onPress={() => void sync.signIn()} />
            ) : (
              <>
                <Button label="Sign out" colors={colors} onPress={() => void sync.signOut({ deleteCloudCopy: false })} />
                <Button label="Sign out and delete synced copy" colors={colors} onPress={() => void sync.signOut({ deleteCloudCopy: true })} />
              </>
            )}
          </View>
        ) : null}
        {name === "iCloud" && sync.state !== "off" ? (
          <Button label="Turn off and delete iCloud copy" colors={colors} onPress={() => void sync.signOut({ deleteCloudCopy: true })} />
        ) : null}
        {name === PLATFORM_CLOUD ? (
          <Text style={{ color: colors.muted }}>
            Deleting the synced copy removes it from your {name}. Other devices still signed in will upload their data again; sign out or turn sync
            off on them first.
          </Text>
        ) : null}
      </View>

      <View style={styles.row}>
        <TextInput
          testID={`draft-${name}`}
          style={[styles.input, { color: colors.text, borderColor: colors.muted }]}
          placeholder="New note"
          placeholderTextColor={colors.muted}
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={() => add()}
        />
        <Button label="Add" colors={colors} onPress={() => add()} />
      </View>
      {notes.length === 0 ? <Text style={{ color: colors.muted }}>No notes yet.</Text> : null}
      {notes.map((note) =>
        editing?.id === note.id ? (
          <View key={note.id} style={styles.row}>
            <TextInput
              autoFocus
              style={[styles.input, { color: colors.text, borderColor: colors.muted }]}
              value={editing.body}
              onChangeText={(body) => setEditing({ id: note.id, body })}
              onSubmitEditing={() => save()}
            />
            <Button label="Save" colors={colors} onPress={() => save()} />
          </View>
        ) : (
          <View key={note.id} style={styles.row}>
            <Pressable style={styles.note} onPress={() => setEditing({ id: note.id, body: note.body })}>
              <Text style={{ color: colors.text }}>{note.body}</Text>
            </Pressable>
            <Button label="Delete" colors={colors} onPress={() => after(deleteNote(db, note.id))} />
          </View>
        ),
      )}
    </View>
  );
}

function Button({ label, onPress, colors, selected }: { label: string; onPress: () => void; colors: Colors; selected?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.button, { backgroundColor: selected ? colors.accent : colors.button, opacity: pressed ? 0.6 : 1 }]}
    >
      <Text style={{ color: selected ? colors.onAccent : colors.text }}>{label}</Text>
    </Pressable>
  );
}

function Toggle({ label, value, onChange, colors }: { label: string; value: boolean; onChange: (value: boolean) => void; colors: Colors }) {
  return (
    <View style={styles.toggle}>
      <Text style={{ color: colors.text }}>{label}</Text>
      <Switch value={value} onValueChange={onChange} />
    </View>
  );
}

type Colors = typeof LIGHT;
const LIGHT = { background: "#f2f2f7", card: "#ffffff", text: "#000000", muted: "#6e6e73", button: "#e5e5ea", accent: "#007aff", onAccent: "#ffffff", danger: "#d70015" };
const DARK: Colors = { background: "#000000", card: "#1c1c1e", text: "#ffffff", muted: "#98989f", button: "#2c2c2e", accent: "#0a84ff", onAccent: "#ffffff", danger: "#ff6961" };

const styles = StyleSheet.create({
  screen: { padding: 16, paddingTop: 64, gap: 16 },
  title: { fontSize: 28, fontWeight: "700" },
  card: { borderRadius: 12, padding: 12, gap: 8 },
  heading: { fontSize: 17, fontWeight: "600" },
  sync: { gap: 4 },
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  toggle: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  input: { flex: 1, minWidth: 120, borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, padding: 8 },
  note: { flex: 1, paddingVertical: 6 },
  button: { borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
});
