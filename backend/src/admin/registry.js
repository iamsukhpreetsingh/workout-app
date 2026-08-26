// Route registry — the SECOND auto-discovery mechanism. Every admin route
// is registered through registerRoute(), which both mounts it on Express
// AND records its metadata for GET /admin/api-registry. New endpoints using
// this wrapper appear in the dashboard's API Explorer with zero dashboard
// code changes.
//
// CONVENTION (see backend README): every NEW endpoint anywhere in this
// backend must use registerRoute() instead of raw router.get/post/... —
// run `node scripts/checkRouteRegistry.js` to flag raw registrations.

const REGISTRY = [];

function registerRoute(router, { method, path, description, requiresAuth = true, allowedRoles = [], enforce = null, category = 'Uncategorized' }, handler, roleMiddleware = null) {
  // Tolerate swapped arg order (handler/middleware) from callers: if the
  // 3rd arg is middleware (array or function) and the 4th is a plain
  // function handler, normalize so the middleware always mounts FIRST.
  let h = handler;
  let mw = roleMiddleware;
  // role guards are self-identifying — if one landed in the handler slot,
  // swap so the guard ALWAYS mounts before the handler
  if (h && h.isRoleMiddleware && typeof mw === 'function') {
    [h, mw] = [mw, h];
  }
  if (!mw && Array.isArray(h)) {
    throw new Error(`registerRoute ${method} ${path}: middleware array passed without a handler`);
  }
  if (typeof h !== 'function' && typeof mw === 'function') {
    [h, mw] = [mw, h];
  }
  const m = String(method).toLowerCase();
  if (!['get', 'post', 'patch', 'put', 'delete'].includes(m)) {
    throw new Error(`registerRoute: unsupported method ${method}`);
  }
  // register with Express normally — `enforce` (array of concrete role
  // names) mounts the role guard BEFORE the handler so the constraint is
  // server-side, not just metadata for the explorer. `allowedRoles` is
  // display text for the API Explorer (may be descriptive for routes with
  // dynamic per-table checks).
  if (mw) router[m](path, mw, h);
  else router[m](path, h);
  // ...and record metadata for the admin API Explorer
  REGISTRY.push({
    method: m.toUpperCase(),
    path,
    description: description || '',
    requiresAuth,
    allowedRoles,
    category,
  });
  return handler;
}

function registeredRoutes() {
  return [...REGISTRY]; // sorted copy for the explorer
}

module.exports = { registerRoute, registeredRoutes, REGISTRY };
