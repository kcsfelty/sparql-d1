import type { SqlDatabase } from './d1-types.js';

const connectionIds = new WeakMap<SqlDatabase, string>();

export function connectionIdFor(db: SqlDatabase): string {
  let id = connectionIds.get(db);
  if (!id) {
    id = crypto.randomUUID();
    connectionIds.set(db, id);
  }
  return id;
}
