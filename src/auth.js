import { config } from './config.js';

/**
 * requireApiKey - Fastify preHandler hook.
 *
 * Since there's no real per-player auth yet, this checks for a single
 * shared secret sent by the client in the `x-api-key` header. Anyone who
 * has the key is treated as "a legitimate game client" — this does NOT
 * identify individual players and should NOT be treated as player auth.
 *
 * Swap this out later for real per-player tokens (e.g. Supabase Auth JWT
 * verification) without changing the route handlers themselves — just
 * replace the body of this function.
 */
export function requireApiKey(request, reply, done) {
  const key = request.headers['x-api-key'];

  if (!key || key !== config.clientApiKey) {
    reply.code(401).send({ error: 'unauthorized', message: 'Missing or invalid API key' });
    return;
  }

  done();
}
