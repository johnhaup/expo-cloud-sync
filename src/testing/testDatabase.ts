import { Database } from "bun:sqlite";
import type { SQLiteDatabase } from "expo-sqlite";

type Params = (string | number | null)[];
const flat = (params: unknown[]) => (params.length === 1 && Array.isArray(params[0]) ? params[0] : params) as Params;

/**
 * For tests: the part of expo-sqlite's database the module calls, over bun's SQLite, so the real
 * statements and triggers run. The exclusive transaction runs on the same connection.
 */
export function openTestDatabase(file: Database = new Database(":memory:")): SQLiteDatabase {
  const db = {
    execAsync: async (sql: string) => void file.exec(sql),
    runAsync: async (sql: string, ...params: unknown[]) => {
      const result = file.query(sql).run(...flat(params));
      return { changes: result.changes, lastInsertRowId: Number(result.lastInsertRowid) };
    },
    getAllAsync: async (sql: string, ...params: unknown[]) => file.query(sql).all(...flat(params)),
    getFirstAsync: async (sql: string, ...params: unknown[]) => file.query(sql).get(...flat(params)),
    withTransactionAsync: async (task: () => Promise<void>) => {
      file.exec("BEGIN");
      try {
        await task();
        file.exec("COMMIT");
      } catch (error) {
        file.exec("ROLLBACK");
        throw error;
      }
    },
    withExclusiveTransactionAsync: async (task: (txn: SQLiteDatabase) => Promise<void>) =>
      db.withTransactionAsync(() => task(db as unknown as SQLiteDatabase)),
  };
  return db as unknown as SQLiteDatabase;
}
