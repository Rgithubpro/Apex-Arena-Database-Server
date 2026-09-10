# Apex Arena Middleware Server

Sits between the game client and Turso. Fastify + `@libsql/client`, built for
Render's free tier (512 MB RAM, 0.1 vCPU).

## What it does

Every table is driven by one config file, `src/tables.config.js` — adding a
new table means editing that file, not writing new routes.

- **Generic REST API** (`/data/:table/...`) covers read, write (upsert),
  delete, and filtered list for any table declared in the config.
- **Per-table, per-action auth.** Each table declares whether `read`,
  `write`, and `delete` are `public` or need the API key — independently.
  `general-data` is public-read/key-write; `logs` is public-write with no
  read/delete at all.
- **Per-table caching.** Tables marked `cached: true` (like `general-data`)
  live entirely in RAM. Reads never touch Turso. The cache auto-refreshes
  every `GENERAL_DATA_REFRESH_MS` (default 60s), updates immediately on
  writes, and can be force-refreshed on demand (see below).
- **Per-table write batching.** Tables marked `batched: true` (like `logs`)
  queue writes in memory and flush to Turso as one batch transaction every
  `FLUSH_INTERVAL_MS` (default 5 min), at a 200-item safety threshold, or on
  shutdown.
- **Graceful shutdown.** On `SIGTERM`/`SIGINT` (what Render sends when
  sleeping/restarting a free instance), all pending batched writes are
  flushed to Turso before the process exits.
- **Rate limits:** 150 req/sec per IP on reads, 3 req/sec per IP on writes.
- **50 KB request body cap.**

## Endpoints

| Method | Path                        | Notes                                                        |
|--------|-----------------------------|---------------------------------------------------------------|
| GET    | `/health`                   | Uptime, per-table cache status, pending write counts          |
| GET    | `/data/:table/:key`         | Single row by the table's `keyColumn`. Auth per table config. |
| GET    | `/data/:table`              | List rows. Query params filter by column; `?limit=N` caps page size (max 500). |
| POST   | `/data/:table`               | Upsert — insert if `keyColumn` doesn't exist, overwrite if it does. |
| DELETE | `/data/:table/:key`         | Delete by key. Auth per table config.                          |
| POST   | `/data/:table/_refresh`     | Force-reload a cached table from Turso right now. Always needs the API key. |

**Examples against the two tables set up now:**

```bash
# public read
GET /data/general-data/game_version
GET /data/general-data                  # all rows
GET /data/general-data?name=game_version  # filtered

# key-gated write (upsert)
POST /data/general-data
x-api-key: <key>
{ "name": "game_version", "value": "V1.0.2" }

# public write, no key needed
POST /data/logs
{ "event": "player_joined", "player": "abc123" }
# -> whole body is stored as the row's `data` column (see wrapBodyAs below)

# force a cache refresh right now instead of waiting for the timer
POST /data/general-data/_refresh
x-api-key: <key>
```

## Adding a new table

Edit `src/tables.config.js`. Each entry needs:

- `keyColumn` — column used for single-row lookups (must be UNIQUE/PK in Turso for writes to work)
- `idColumn` — the real primary key (can be the same as `keyColumn`, e.g. logs)
- `columns` — full column list, also used to whitelist what a write can set
- `cached` — whole table in RAM, reads never hit Turso (small, read-heavy tables)
- `batched` — writes queue in memory, flush periodically (high-volume, write-heavy tables)
- `wrapBodyAs` — optional; if set, the whole POST body becomes that one column's value (used for `logs.data`) instead of being read as `{column: value}` pairs
- `actions` — `{ read: {auth}, write: {auth}, delete: {auth} }`, `auth` is `'public'` or `'apiKey'`; omit an action entirely to disable it for that table

No route code changes needed — the generic engine in `src/db.js` and routes in `src/server.js` read this config at request time.

## ⚠️ Required: add a UNIQUE constraint before deploying

Upserts use `INSERT ... ON CONFLICT(keyColumn) DO UPDATE`, which requires a
UNIQUE (or PRIMARY KEY) constraint on that column in Turso. Your current
`general-data` table only has `name` as plain `text` — writes will fail
until you add this:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_general_data_name ON "general-data" (name);
```

`logs` doesn't need this since its keyColumn (`id`) is already the primary key.

## Setup

```bash
npm install
cp .env.example .env
# fill in TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, CLIENT_API_KEY, ALLOWED_ORIGINS
npm start
```

Get your Turso credentials with the Turso CLI:
```bash
turso db show --url <database-name>
turso db tokens create <database-name>
```

## Deploying to Render

1. Push this repo to GitHub.
2. In Render: New → Blueprint → point at the repo (it will read `render.yaml`).
3. Fill in the secret env vars Render will prompt for (`TURSO_DATABASE_URL`,
   `TURSO_AUTH_TOKEN`, `CLIENT_API_KEY`, `ALLOWED_ORIGINS`).
4. Deploy. Health check is `/health`.

`ALLOWED_ORIGINS` should be a comma-separated list of your client's actual
origins, e.g. `http://127.0.0.1:5500,https://your-username.github.io` — avoid
`*` once you're in production.

## Auth — read this

There's no real per-player auth yet. `CLIENT_API_KEY` is a **single shared
secret** — anyone holding it is treated as "a legitimate game client," not
as a specific player. It stops randoms from hitting write endpoints directly,
but it does **not** stop one player from editing another player's data, since
there's no concept of "which player is this" yet.

When you add real player auth (e.g. Supabase Auth JWTs), the integration
point is `src/auth.js` — replace the body of `requireApiKey` with JWT
verification, and it'll apply to every route that currently uses it without
touching `server.js`.

## Extending for player data

Once you decide the player table shape, add it to `src/tables.config.js` —
no new route code. A likely starting point:

```js
players: {
  keyColumn: 'id',
  idColumn: 'id',
  columns: ['id', 'name', 'data'], // data = JSON blob for flexibility
  cached: false,   // probably too big to cache in full; revisit if needed
  batched: false,  // player writes should probably land immediately, not batch
  actions: {
    read: { auth: 'apiKey' },
    write: { auth: 'apiKey' },
  },
},
```

The real gap for player data isn't the table config — it's that `apiKey`
auth can't tell player A's request from player B's. Before wiring up
anything that writes player-owned data, `src/auth.js` needs real per-player
identity (e.g. verifying a Supabase Auth JWT and exposing `request.userId`),
and the write path needs an ownership check (a player can only write their
own row). Happy to build that when you're ready.
