import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';

import { config } from './config.js';
import { requireApiKey } from './auth.js';
import { tablesConfig, getTableConfig } from './tables.config.js';
import {
  loadAllCaches,
  isCacheReady,
  startCacheRefreshLoops,
  loadCache,
  readOne,
  readMany,
  writeOne,
  deleteOne,
  flushAllQueues,
  startFlushLoops,
  allPendingCounts,
} from './db.js';

const fastify = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'info',
    transport:
      process.env.NODE_ENV === 'production'
        ? undefined
        : { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } },
  },
  bodyLimit: config.maxPayloadBytes, // hard cap on incoming request body size (50 KB default)
  trustProxy: true, // Render sits behind a proxy; needed for correct per-IP rate limiting
});

// ---------------------------------------------------------------------------
// Global plugins
// ---------------------------------------------------------------------------

await fastify.register(cors, {
  origin: config.allowedOrigins.includes('*') ? true : config.allowedOrigins,
});

// Base rate limit applied to every route as a floor; individual routes
// override this with tighter read/write limits via route-level config.
await fastify.register(rateLimit, {
  global: true,
  max: config.readRateLimit.max,
  timeWindow: config.readRateLimit.timeWindow,
  keyGenerator: (req) => req.ip,
  errorResponseBuilder: () => ({
    statusCode: 429,
    error: 'rate_limited',
    message: 'Too many requests. Please slow down.',
  }),
});

// Clean, consistent error responses instead of leaking stack traces / 500s
// for expected conditions like oversized payloads or bad JSON.
fastify.setErrorHandler((err, request, reply) => {
  if (err.statusCode === 413 || err.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
    reply.code(413).send({ error: 'payload_too_large', message: 'Request body exceeds the 50 KB limit' });
    return;
  }

  if (err.statusCode === 429 || err.code === 'FST_RATE_LIMIT') {
    reply.code(429).send({ error: 'rate_limited', message: 'Too many requests. Please slow down.' });
    return;
  }

  if (
    err.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' ||
    err.code === 'FST_ERR_CTP_EMPTY_JSON_BODY' ||
    err instanceof SyntaxError ||
    err.statusCode === 400
  ) {
    reply.code(400).send({ error: 'bad_request', message: err.message || 'Invalid or malformed request' });
    return;
  }

  request.log.error(err);
  reply.code(err.statusCode || 500).send({ error: 'internal_error', message: 'Something went wrong' });
});

// ---------------------------------------------------------------------------
// Table validation preHandler - runs before every /data/:table/* route.
// Confirms the table exists in config and the requested action is enabled
// for it, then enforces that action's auth requirement (public or apiKey).
// ---------------------------------------------------------------------------

function tableGuard(actionName) {
  return function (request, reply, done) {
    const { table } = request.params;
    const tableCfg = getTableConfig(table);

    if (!tableCfg) {
      reply.code(404).send({ error: 'not_found', message: `No such table "${table}"` });
      return;
    }

    const action = tableCfg.actions[actionName];
    if (!action) {
      reply.code(405).send({
        error: 'action_not_allowed',
        message: `"${actionName}" is not enabled for table "${table}"`,
      });
      return;
    }

    request.tableCfg = tableCfg;

    if (action.auth === 'apiKey') {
      requireApiKey(request, reply, done);
      return;
    }

    done();
  };
}

// ---------------------------------------------------------------------------
// Health check (unauthenticated, unlimited - Render + you both need this)
// ---------------------------------------------------------------------------

fastify.get('/health', { config: { rateLimit: false } }, async () => {
  const cacheStatus = {};
  for (const tableName of Object.keys(tablesConfig)) {
    if (getTableConfig(tableName).cached) cacheStatus[tableName] = isCacheReady(tableName);
  }

  return {
    status: 'ok',
    cacheStatus,
    pendingWrites: allPendingCounts(),
    uptimeSeconds: Math.round(process.uptime()),
  };
});

// ---------------------------------------------------------------------------
// GET /data/:table/:key - single row lookup
// ---------------------------------------------------------------------------

fastify.get(
  '/data/:table/:key',
  {
    preHandler: tableGuard('read'),
    config: {
      rateLimit: { max: config.readRateLimit.max, timeWindow: config.readRateLimit.timeWindow },
    },
  },
  async (request, reply) => {
    const { table, key } = request.params;
    const tableCfg = request.tableCfg;

    if (tableCfg.cached && !isCacheReady(table)) {
      reply.code(503);
      return { error: 'not_ready', message: 'Cache is still warming up, try again shortly' };
    }

    const row = await readOne(table, key);
    if (row === undefined) {
      reply.code(404);
      return { error: 'not_found', message: `No row in "${table}" with ${tableCfg.keyColumn} = "${key}"` };
    }
    return row;
  },
);

// ---------------------------------------------------------------------------
// GET /data/:table - list rows, optional filters via query string
// e.g. GET /data/logs?event=player_joined&limit=50
// "limit" is reserved and controls page size; every other query param is
// treated as an exact-match column filter (only whitelisted columns apply).
// ---------------------------------------------------------------------------

fastify.get(
  '/data/:table',
  {
    preHandler: tableGuard('read'),
    config: {
      rateLimit: { max: config.readRateLimit.max, timeWindow: config.readRateLimit.timeWindow },
    },
  },
  async (request, reply) => {
    const { table } = request.params;
    const tableCfg = request.tableCfg;

    if (tableCfg.cached && !isCacheReady(table)) {
      reply.code(503);
      return { error: 'not_ready', message: 'Cache is still warming up, try again shortly' };
    }

    const { limit, ...filters } = request.query || {};
    const rows = await readMany(table, filters, limit);
    return { table, count: rows.length, rows };
  },
);

// ---------------------------------------------------------------------------
// POST /data/:table - write (upsert). Body must include the table's
// keyColumn; if a row with that key exists it's overwritten, else created.
// ---------------------------------------------------------------------------

fastify.post(
  '/data/:table',
  {
    preHandler: tableGuard('write'),
    config: {
      rateLimit: { max: config.writeRateLimit.max, timeWindow: config.writeRateLimit.timeWindow },
    },
  },
  async (request, reply) => {
    const { table } = request.params;
    const body = request.body;

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      reply.code(400);
      return { error: 'bad_request', message: 'Request body must be a JSON object' };
    }

    const result = await writeOne(table, body);
    reply.code(result.queued ? 202 : 200);
    return result;
  },
);

// ---------------------------------------------------------------------------
// DELETE /data/:table/:key
// ---------------------------------------------------------------------------

fastify.delete(
  '/data/:table/:key',
  {
    preHandler: tableGuard('delete'),
    config: {
      rateLimit: { max: config.writeRateLimit.max, timeWindow: config.writeRateLimit.timeWindow },
    },
  },
  async (request, reply) => {
    const { table, key } = request.params;
    await deleteOne(table, key);
    return { deleted: true, table, key };
  },
);

// ---------------------------------------------------------------------------
// POST /data/:table/_refresh - manually force a cache reload from Turso.
// Only meaningful for cached tables; always requires an API key regardless
// of the table's `read` auth setting, since it triggers an extra DB read.
// ---------------------------------------------------------------------------

fastify.post(
  '/data/:table/_refresh',
  {
    preHandler: requireApiKey,
    config: {
      rateLimit: { max: config.writeRateLimit.max, timeWindow: config.writeRateLimit.timeWindow },
    },
  },
  async (request, reply) => {
    const { table } = request.params;
    const tableCfg = getTableConfig(table);

    if (!tableCfg) {
      reply.code(404);
      return { error: 'not_found', message: `No such table "${table}"` };
    }
    if (!tableCfg.cached) {
      reply.code(400);
      return { error: 'bad_request', message: `Table "${table}" is not cached, nothing to refresh` };
    }

    const count = await loadCache(table);
    return { table, refreshed: true, entries: count };
  },
);

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function start() {
  try {
    fastify.log.info('Loading table caches from Turso...');
    const counts = await loadAllCaches();
    for (const [table, count] of Object.entries(counts)) {
      fastify.log.info(`Loaded ${count} row(s) into cache for "${table}"`);
    }

    startCacheRefreshLoops();
    startFlushLoops();

    await fastify.listen({ port: config.port, host: '0.0.0.0' });
    fastify.log.info(`Server listening on port ${config.port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Graceful shutdown - flush any pending batched writes before exiting so no
// data is lost when Render stops or restarts the instance.
// ---------------------------------------------------------------------------

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  fastify.log.info(`Received ${signal}, flushing pending writes before shutdown...`);

  try {
    const results = await flushAllQueues();
    fastify.log.info(`Flushed on shutdown: ${JSON.stringify(results)}`);
  } catch (err) {
    fastify.log.error('Failed to flush on shutdown:', err.message);
  }

  try {
    await fastify.close();
  } finally {
    process.exit(0);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start();
