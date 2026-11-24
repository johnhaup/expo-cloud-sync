export const resolveTable = (table) => ({
    name: table.name,
    key: table.key ?? "id",
    tombstone: table.tombstone === undefined ? "deleted_at" : table.tombstone,
    excludeKeys: table.excludeKeys ?? [],
});
export const quote = (name) => `"${name.replaceAll('"', '""')}"`;
const literal = (value) => `'${value.replaceAll("'", "''")}'`;
/** SQL condition on `column` that leaves out the table's excluded keys ("1" when there are none). */
export const notExcluded = (table, column) => table.excludeKeys.length ? `${column} NOT IN (${table.excludeKeys.map(literal).join(", ")})` : "1";
export const getMeta = async (db, key) => (await db.getFirstAsync("SELECT value FROM _sync_meta WHERE key = ?", key))?.value ?? null;
export const setMeta = (db, key, value) => db.runAsync("INSERT OR REPLACE INTO _sync_meta (key, value) VALUES (?, ?)", key, value);
export const deleteMeta = (db, key) => db.runAsync("DELETE FROM _sync_meta WHERE key = ?", key);
export const columnsOf = async (db, table) => (await db.getAllAsync(`PRAGMA table_info(${quote(table)})`)).map(({ name }) => name);
/** Every row with a real stamp becomes dirty: the start of a first sync. Seeded rows (stamp 0) stay out. */
export async function markAllDirty(db, config) {
    for (const table of config.tables.map(resolveTable)) {
        const key = quote(table.key);
        await db.runAsync(`INSERT OR REPLACE INTO _sync_changes (table_name, row_id)
       SELECT ?, ${key} FROM ${quote(table.name)} WHERE updated_at > 0 AND ${notExcluded(table, key)}`, table.name);
    }
}
/**
 * Forget what this device knew about the cloud copy (cursor, change tags) and mark everything dirty,
 * so the next cycle pulls everything and pushes what wins here. Nothing local is deleted.
 */
export async function beginFirstSync(db, config) {
    await deleteMeta(db, "cursor");
    await db.runAsync("DELETE FROM _sync_rows");
    await markAllDirty(db, config);
}
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS _sync_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS _sync_changes (table_name TEXT NOT NULL, row_id TEXT NOT NULL, PRIMARY KEY (table_name, row_id)) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS _sync_rows (table_name TEXT NOT NULL, row_id TEXT NOT NULL, sys TEXT, PRIMARY KEY (table_name, row_id)) WITHOUT ROWID;
`;
const NOT_APPLYING = "(SELECT value FROM _sync_meta WHERE key = 'applying') IS NOT '1'";
function triggersFor(table) {
    const t = quote(table.name);
    const k = quote(table.key);
    const name = (suffix) => quote(`_sync_${table.name}_${suffix}`);
    const tableName = literal(table.name);
    const sql = [
        `CREATE TRIGGER ${name("ins")} AFTER INSERT ON ${t}
     WHEN ${NOT_APPLYING} AND NEW.updated_at > 0 AND ${notExcluded(table, `NEW.${k}`)}
     BEGIN INSERT OR REPLACE INTO _sync_changes (table_name, row_id) VALUES (${tableName}, NEW.${k}); END;`,
        // Keeps a row's stamp moving forward, so a row stamped by a device with a fast clock (or a write
        // that forgot to bump it) still wins its next edit. Recursive triggers are off: the inner UPDATE
        // does not fire this trigger again.
        `CREATE TRIGGER ${name("upd")} AFTER UPDATE ON ${t}
     WHEN ${NOT_APPLYING} AND ${notExcluded(table, `NEW.${k}`)}
     BEGIN
       UPDATE ${t} SET updated_at = OLD.updated_at + 1 WHERE ${k} = NEW.${k} AND NEW.updated_at <= OLD.updated_at;
       INSERT OR REPLACE INTO _sync_changes (table_name, row_id) VALUES (${tableName}, NEW.${k});
     END;`,
    ];
    if (table.tombstone) {
        sql.push(`CREATE TRIGGER ${name("del")} BEFORE DELETE ON ${t}
       WHEN ${NOT_APPLYING}
       BEGIN SELECT RAISE(ABORT, 'cloud-sync: hard delete on a synced table'); END;`);
    }
    return sql;
}
/**
 * Creates the _sync tables and triggers and runs restore detection. Call after migrate(), before the
 * first read. `deviceId` is the native id kept outside every backup: a database whose stored id differs
 * came from another install (a restore or transfer) and starts a first sync.
 */
export async function installSyncWith(db, config, deviceId) {
    const pragma = await db.getFirstAsync("PRAGMA recursive_triggers");
    if (pragma?.recursive_triggers)
        throw new Error("cloud-sync: PRAGMA recursive_triggers must be off");
    const tables = config.tables.map(resolveTable);
    for (const table of tables) {
        const columns = await columnsOf(db, table.name);
        if (!columns.length)
            throw new Error(`cloud-sync: table ${table.name} does not exist`);
        for (const column of [table.key, "updated_at", table.tombstone]) {
            if (column && !columns.includes(column))
                throw new Error(`cloud-sync: ${table.name} has no column ${column}`);
        }
    }
    await db.withTransactionAsync(async () => {
        await db.execAsync(SCHEMA);
        // Dropped and recreated on every start, so a config change (a new table, a new excluded key) takes effect.
        const old = await db.getAllAsync("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '\\_sync\\_%' ESCAPE '\\'");
        for (const { name } of old)
            await db.execAsync(`DROP TRIGGER ${quote(name)}`);
        for (const table of tables)
            for (const sql of triggersFor(table))
                await db.execAsync(sql);
        if ((await getMeta(db, "device_id")) !== deviceId) {
            await setMeta(db, "device_id", deviceId);
            await beginFirstSync(db, config);
        }
    });
}
