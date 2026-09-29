export class Store {
  constructor(private sql: SqlStorage) {
    sql.exec(
      "CREATE TABLE IF NOT EXISTS records (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
  }
  get<T>(key: string): T | undefined {
    const row = this.sql
      .exec<{ value: string }>("SELECT value FROM records WHERE key=?", key)
      .toArray()[0];
    return row ? JSON.parse(row.value) : undefined;
  }
  put(key: string, value: unknown) {
    this.sql.exec(
      "INSERT INTO records(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      key,
      JSON.stringify(value),
    );
  }
  remove(key: string) {
    this.sql.exec("DELETE FROM records WHERE key=?", key);
  }
  list<T>(prefix: string, limit = 1000): { key: string; value: T }[] {
    return this.sql
      .exec<{ key: string; value: string }>(
        "SELECT key,value FROM records WHERE key LIKE ? ORDER BY key LIMIT ?",
        prefix + "%",
        limit,
      )
      .toArray()
      .map((r) => ({ key: r.key, value: JSON.parse(r.value) }));
  }
}
