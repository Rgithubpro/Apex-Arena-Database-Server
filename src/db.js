import { createClient } from '@libsql/client';
import { config } from './config.js';
import { tablesConfig, getTableConfig } from './tables.config.js';

export const turso = createClient({
  url: config.tursoUrl,
  authToken: config.tursoAuthToken,
});

// ---------------------------------------------------------------------------
// Per-table runtime state, built from tablesConfig at startup.
// ---------------------------------------------------------------------------

const state = {}; // tableName -> { cache: Map, cacheReady, queue: [] }

for (const tableName of Object.keys(tablesConfig)) {
  state[tableName] = {
    cache: new Map(), // keyColumn value -> row object
    cacheReady: false,
    queue: [], // pending writes, for batched tables
  };
}

function quoteTable(tableName) {
  // Turso/SQLite: always safe to quote identifiers, handles names with dashes.
  return `"${tableName}"`;
}

function rowToObject(tableCfg, row) {
  const obj = {};
  for (const col of tableCfg.columns) {
    obj[col] = row[col];
  }
  return obj;
}

// ---------------------------------------------------------------------------
// Cache loading (for cached: true tables)
// ---------------------------------------------------------------------------

export async function loadCache(tableName) {
  const tableCfg = getTableConfig(tableName);
  if (!tableCfg || !tableCfg.cached) return 0;

  const result = await turso.execute(`SELECT * FROM ${quoteTable(tableName)}`);
  const s = state[tableName];
  s.cache.clear();
  for (const row of result.rows) {
    const obj = rowToObject(tableCfg, row);
    s.cache.set(obj[tableCfg.keyColumn], obj);
  }
  s.cacheReady = true;
  return s.cache.size;
}

export async function loadAllCaches() {
  const results = {};
  for (const tableName of Object.keys(tablesConfig)) {
    const tableCfg = getTableConfig(tableName);
    if (tableCfg.cached) {
      results[tableName] = await loadCache(tableName);
    }
  }
  return results;
}

export function isCacheReady(tableName) {
  const tableCfg = getTableConfig(tableName);
  if (!tableCfg || !tableCfg.cached) return true; // non-cached tables are always "ready"
  return state[tableName].cacheReady;
}

export function startCacheRefreshLoops() {
  for (const tableName of Object.keys(tablesConfig)) {
    const tableCfg = getTableConfig(tableName);
    if (!tableCfg.cached) continue;

    setInterval(() => {
      loadCache(tableName).catch((err) => {
        console.error(`[${tableName}] background cache refresh failed:`, err.message);
      });
    }, config.generalDataRefreshMs).unref();
  }
}

// ---------------------------------------------------------------------------
// READ
// ---------------------------------------------------------------------------

/** Single row lookup by keyColumn value. Returns undefined if not found. */
export async function readOne(tableName, keyValue) {
  const tableCfg = getTableConfig(tableName);
  const s = state[tableName];

  if (tableCfg.cached) {
    return s.cache.get(keyValue);
  }

  const result = await turso.execute({
    sql: `SELECT * FROM ${quoteTable(tableName)} WHERE ${tableCfg.keyColumn} = ? LIMIT 1`,
    args: [keyValue],
  });
  if (result.rows.length === 0) return undefined;
  return rowToObject(tableCfg, result.rows[0]);
}

/**
 * List rows, optionally filtered by exact-match column=value pairs.
 * `filters` is a plain object like { status: 'active' }. Only columns
 * declared in the table's `columns` list are honored, to prevent SQL
 * injection via arbitrary column names.
 */
export async function readMany(tableName, filters = {}, limit = 100) {
  const tableCfg = getTableConfig(tableName);
  const s = state[tableName];
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);

  const validFilters = Object.entries(filters).filter(([col]) => tableCfg.columns.includes(col));

  if (tableCfg.cached) {
    let rows = Array.from(s.cache.values());
    for (const [col, val] of validFilters) {
      rows = rows.filter((r) => String(r[col]) === String(val));
    }
    return rows.slice(0, safeLimit);
  }

  let sql = `SELECT * FROM ${quoteTable(tableName)}`;
  const args = [];
  if (validFilters.length > 0) {
    sql += ' WHERE ' + validFilters.map(([col]) => `${col} = ?`).join(' AND ');
    args.push(...validFilters.map(([, val]) => val));
  }
  sql += ` LIMIT ?`;
  args.push(safeLimit);

  const result = await turso.execute({ sql, args });
  return result.rows.map((row) => rowToObject(tableCfg, row));
}

// ---------------------------------------------------------------------------
// WRITE (upsert - insert or overwrite existing row)
// ---------------------------------------------------------------------------

/**
 * Upsert a row. `data` is a plain object of column -> value (keyColumn
 * required; idColumn auto-generated if this is a new row and not supplied).
 * Only whitelisted columns from tableCfg.columns are written.
 */
export async function writeOne(tableName, data) {
  const tableCfg = getTableConfig(tableName);
  const s = state[tableName];

  // If keyColumn IS the idColumn (e.g. logs: keyColumn="id"), the caller
  // doesn't need to supply it - it's always server-generated for new rows.
  // Otherwise (e.g. general-data: keyColumn="name", idColumn="id") the
  // caller must supply the keyColumn value, since that's how we know which
  // row to upsert.
  const keyIsId = tableCfg.keyColumn === tableCfg.idColumn;
  let keyValue = data[tableCfg.keyColumn];

  if (!keyIsId && (keyValue === undefined || keyValue === null)) {
    throw Object.assign(new Error(`Missing required field "${tableCfg.keyColumn}"`), { statusCode: 400 });
  }

  // Build the row to write, whitelisted to known columns only.
  const row = {};
  if (tableCfg.wrapBodyAs) {
    // The whole POST body becomes the value of one column (e.g. logs.data).
    row[tableCfg.wrapBodyAs] = JSON.stringify(data);
  } else {
    for (const col of tableCfg.columns) {
      if (data[col] !== undefined) row[col] = data[col];
    }
  }
  if (row[tableCfg.idColumn] === undefined) {
    row[tableCfg.idColumn] = crypto.randomUUID();
  }
  if (keyIsId) {
    keyValue = row[tableCfg.idColumn];
  }
  if (tableCfg.columns.includes('created_at') && row.created_at === undefined) {
    row.created_at = new Date().toISOString();
  }

  if (tableCfg.batched) {
    s.queue.push(row);
    if (s.queue.length >= config.batchFlushThreshold) {
      flushQueue(tableName).catch((err) => {
        console.error(`[${tableName}] threshold-triggered flush failed:`, err.message);
      });
    }
    return { queued: true, ...row };
  }

  // Non-batched: write through to Turso immediately (upsert via
  // INSERT ... ON CONFLICT, which is the correct/atomic way to do this in
  // libSQL/SQLite - avoids a separate SELECT-then-INSERT-or-UPDATE race).
  const cols = Object.keys(row);
  const placeholders = cols.map(() => '?').join(', ');
  const updateClause = cols
    .filter((c) => c !== tableCfg.idColumn)
    .map((c) => `${c} = excluded.${c}`)
    .join(', ');

  const sql = `
    INSERT INTO ${quoteTable(tableName)} (${cols.join(', ')})
    VALUES (${placeholders})
    ON CONFLICT(${tableCfg.keyColumn}) DO UPDATE SET ${updateClause}
  `;

  await turso.execute({ sql, args: cols.map((c) => row[c]) });

  // The row we built client-side may have a generated `id` that doesn't
  // match what's actually in Turso (ON CONFLICT preserves the existing
  // row's id on update). Re-read the authoritative row so the cache and
  // response always reflect the true stored id.
  const finalRow = await readFromTurso(tableName, tableCfg, keyValue);

  if (tableCfg.cached && finalRow) {
    s.cache.set(keyValue, finalRow);
  }

  return finalRow || row;
}

async function readFromTurso(tableName, tableCfg, keyValue) {
  const result = await turso.execute({
    sql: `SELECT * FROM ${quoteTable(tableName)} WHERE ${tableCfg.keyColumn} = ? LIMIT 1`,
    args: [keyValue],
  });
  if (result.rows.length === 0) return undefined;
  return rowToObject(tableCfg, result.rows[0]);
}

// ---------------------------------------------------------------------------
// DELETE
// ---------------------------------------------------------------------------

export async function deleteOne(tableName, keyValue) {
  const tableCfg = getTableConfig(tableName);
  const s = state[tableName];

  await turso.execute({
    sql: `DELETE FROM ${quoteTable(tableName)} WHERE ${tableCfg.keyColumn} = ?`,
    args: [keyValue],
  });

  if (tableCfg.cached) {
    s.cache.delete(keyValue);
  }

  return true;
}

// ---------------------------------------------------------------------------
// Batched write queue (for batched: true tables, e.g. logs)
// ---------------------------------------------------------------------------

export async function flushQueue(tableName) {
  const tableCfg = getTableConfig(tableName);
  const s = state[tableName];
  if (s.queue.length === 0) return 0;

  const batch = s.queue;
  s.queue = [];

  const cols = tableCfg.columns;
  const placeholders = cols.map(() => '?').join(', ');
  const sql = `INSERT INTO ${quoteTable(tableName)} (${cols.join(', ')}) VALUES (${placeholders})`;

  try {
    await turso.batch(
      batch.map((row) => ({ sql, args: cols.map((c) => row[c]) })),
      'write',
    );
    return batch.length;
  } catch (err) {
    // Put the failed batch back so we don't silently lose data.
    s.queue = batch.concat(s.queue);
    throw err;
  }
}

export async function flushAllQueues() {
  const results = {};
  for (const tableName of Object.keys(tablesConfig)) {
    const tableCfg = getTableConfig(tableName);
    if (tableCfg.batched) {
      results[tableName] = await flushQueue(tableName);
    }
  }
  return results;
}

export function startFlushLoops() {
  for (const tableName of Object.keys(tablesConfig)) {
    const tableCfg = getTableConfig(tableName);
    if (!tableCfg.batched) continue;

    const interval = setInterval(() => {
      flushQueue(tableName)
        .then((count) => {
          if (count > 0) console.log(`[${tableName}] flushed ${count} row(s) to Turso`);
        })
        .catch((err) => {
          console.error(`[${tableName}] periodic flush failed:`, err.message);
        });
    }, config.flushIntervalMs);
    interval.unref();
  }
}

export function pendingCount(tableName) {
  return state[tableName]?.queue.length ?? 0;
}

export function allPendingCounts() {
  const out = {};
  for (const tableName of Object.keys(tablesConfig)) {
    const tableCfg = getTableConfig(tableName);
    if (tableCfg.batched) out[tableName] = pendingCount(tableName);
  }
  return out;
}
