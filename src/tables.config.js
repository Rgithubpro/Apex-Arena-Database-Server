/**
 * Table config — one place to declare how each Turso table behaves through
 * the generic /data/:table API. Add a new table here; no route code needed.
 *
 * Fields:
 * - keyColumn: the column used for single-row lookups (GET/POST/DELETE /data/:table/:key).
 *              Must have a UNIQUE or PRIMARY KEY constraint in Turso for write (upsert) to be safe.
 * - idColumn: the actual primary key column (usually a uuid). If different
 *             from keyColumn (e.g. keyColumn = "name" but PK is "id"), set this.
 * - columns: full list of columns, in the order you want them returned. Also
 *            used to validate/whitelist what a write can set.
 * - cached: if true, the whole table is loaded into RAM and kept there.
 *           Reads (single + list) are served from cache, never hit Turso.
 *           Writes/deletes go straight to Turso AND patch the cache.
 *           Use for small, read-heavy tables (config, game data). Do NOT use
 *           for high-volume tables like logs.
 * - batched: if true, writes are queued in memory and flushed to Turso in
 *            a batch periodically / on shutdown, instead of one write per
 *            request. Use for high-volume, write-only tables like logs.
 *            A table should be `cached` XOR `batched` XOR neither — not both
 *            cached and batched.
 * - wrapBodyAs: optional. If set (e.g. "data"), the entire POST body is
 *               treated as the value for that one column, instead of being
 *               read as {column: value, ...} pairs. Use this for tables
 *               where the client just wants to send an arbitrary JSON blob
 *               (like logs) without knowing internal column names.
 * - actions: which operations are exposed, and what each requires.
 *     read:   { auth: 'public' | 'apiKey' | 'adminKey' | 'disabled' }
 *     write:  { auth: 'public' | 'apiKey' | 'adminKey' | 'disabled' }   // upsert - insert or overwrite
 *     delete: { auth: 'public' | 'apiKey' | 'adminKey' | 'disabled' }
 *   Omit an action entirely to disable it for that table (same effect as
 *   `disabled`, but `disabled` is more explicit/self-documenting if you
 *   want it to show up clearly in this file).
 *   'apiKey' = the shared CLIENT_API_KEY (x-api-key header).
 *   'adminKey' = a separate, more-secret ADMIN_API_KEY (x-admin-key header) -
 *                use this for dangerous actions like delete. If ADMIN_API_KEY
 *                isn't set on the server, adminKey-gated actions always reject.
 */

export const tablesConfig = {
  'general-data': {
    keyColumn: 'name',
    idColumn: 'id',
    columns: ['id', 'name', 'value'],
    cached: true,
    batched: false,
    actions: {
      read: { auth: 'public' },
      write: { auth: 'disabled' },
      delete: { auth: 'disabled' }, // dangerous - separate admin key required
    },
  },

  logs: {
    keyColumn: 'id',
    idColumn: 'id',
    columns: ['id', 'created_at', 'data'],
    cached: false,
    batched: true,
    wrapBodyAs: 'data',
    actions: {
      // No `read` - logs are not fetchable through the client API on purpose.
      write: { auth: 'public' },
      read: { auth: 'adminKey' },
      // No `delete` - logs are append-only from the client's perspective.
    },
  },
};

export function getTableConfig(tableName) {
  return tablesConfig[tableName];
}