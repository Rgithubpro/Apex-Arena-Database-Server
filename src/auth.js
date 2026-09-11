import { config } from './config.js';

/**
 * Four access levels, used in tables.config.js as the `auth` value for
 * each action (read/write/delete):
 *
 *   'public'   - anyone can call it, no header needed
 *   'apiKey'    - must send the client key in `x-api-key`
 *   'adminKey'  - must send the ADMIN key in `x-admin-key` (separate,
 *                 more-secret key for dangerous actions like deletes)
 *   'disabled'  - nobody can call it, full stop, regardless of headers
 *
 * There's no real per-player auth yet - both key tiers are shared secrets,
 * not identity. Anyone holding a key is treated as "a legitimate client/
 * admin," not as a specific player. See README for how to swap in real
 * per-player auth later without touching route code.
 */

export function requireApiKey(request, reply, done) {
  const key = request.headers['x-api-key'];

  if (!key || key !== config.clientApiKey) {
    reply.code(401).send({ error: 'unauthorized', message: 'Missing or invalid API key' });
    return;
  }

  done();
}

export function requireAdminKey(request, reply, done) {
  if (!config.adminApiKey) {
    // No admin key configured at all - treat every admin-gated route as
    // closed rather than silently falling back to the client key.
    reply.code(503).send({
      error: 'admin_not_configured',
      message: 'This action requires an admin key, but none is configured on the server',
    });
    return;
  }

  const key = request.headers['x-admin-key'];

  if (!key || key !== config.adminApiKey) {
    reply.code(401).send({ error: 'unauthorized', message: 'Missing or invalid admin key' });
    return;
  }

  done();
}

export function denyAlways(request, reply) {
  reply.code(403).send({ error: 'disabled', message: 'This action is disabled' });
}

/**
 * Returns the correct preHandler for a table action's declared auth level.
 * Used by tableGuard() in server.js so route code never has to branch on
 * the auth string itself.
 */
export function authHandlerFor(authLevel) {
  switch (authLevel) {
    case 'public':
      return (request, reply, done) => done();
    case 'apiKey':
      return requireApiKey;
    case 'adminKey':
      return requireAdminKey;
    case 'disabled':
      return denyAlways;
    default:
      // Unknown auth string in config = fail closed, not open.
      return denyAlways;
  }
}