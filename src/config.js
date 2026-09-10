import 'dotenv/config';

function required(name) {
  const val = process.env[name];
  if (!val) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return val;
}

export const config = {
  tursoUrl: required('TURSO_DATABASE_URL'),
  tursoAuthToken: required('TURSO_AUTH_TOKEN'),
  clientApiKey: required('CLIENT_API_KEY'),
  port: parseInt(process.env.PORT || '3000', 10),
  flushIntervalMs: parseInt(process.env.FLUSH_INTERVAL_MS || '300000', 10),
  generalDataRefreshMs: parseInt(process.env.GENERAL_DATA_REFRESH_MS || '60000', 10),
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '*')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // Rate limits (per doc: ~150 reads/sec MAX, 3 writes/sec MAX).
  // Applied per-IP by fastify/rate-limit. Adjust the window/max pair as needed.
  readRateLimit: {
    max: 150,
    timeWindow: '1 second',
  },
  writeRateLimit: {
    max: 3,
    timeWindow: '1 second',
  },

  maxPayloadBytes: 50 * 1024, // 50 KB cap per the doc

  // Safety valve for batched tables (e.g. logs): flush early if the queue
  // grows this large between timed flushes, so memory doesn't run away.
  batchFlushThreshold: 200,
};
