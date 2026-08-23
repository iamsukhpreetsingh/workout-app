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

function registerRoute(router, { method, path, description, requiresAuth = true, allowedRoles = [], category = 'Uncategorized' }, handler) {
  const m = String(method).toLowerCase();
  if (!['get', 'post', 'patch', 'put', 'delete'].includes(m)) {
    throw new Error(`registerRoute: unsupported method ${method}`);
  }
  // register with Express normally...
  router[m](path, handler);
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
