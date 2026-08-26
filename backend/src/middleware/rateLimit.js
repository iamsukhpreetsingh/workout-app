// Minimal fixed-window in-memory rate limiter. Consistent with this
// backend's single-process architecture (no Redis); counters reset on
// restart, which is acceptable for abuse mitigation (not for billing).
// Usage: router.post('/x', rateLimit({ key: 'forgot', max: 5, windowMs: 3600000 }), handler)
//
// The bucket key combines the route key with the client IP (and optionally
// a request attribute like email) so one abuser never locks out others.

const buckets = new Map();

function clientIp(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    'unknown'
  );
}

function rateLimit({ key, max, windowMs, attributeOf = null }) {
  // periodic sweep so abandoned buckets don't grow unbounded
  if (!buckets.has(`__swept_${key}`)) {
    buckets.set(`__swept_${key}`, true);
    setInterval(() => {
      const now = Date.now();
      for (const [k, v] of buckets) {
        if (k.startsWith(`__swept_`)) continue;
        if (k.startsWith(`${key}:`) && now - v.windowStart > windowMs * 2) buckets.delete(k);
      }
    }, windowMs).unref();
  }

  return (req, res, next) => {
    const attr = attributeOf ? String(attributeOf(req) || '').toLowerCase() : '';
    const bucketKey = `${key}:${attr ? attr + '|' : ''}${clientIp(req)}`;
    const now = Date.now();

    let b = buckets.get(bucketKey);
    if (!b || now - b.windowStart > windowMs) {
      b = { windowStart: now, count: 0 };
      buckets.set(bucketKey, b);
    }
    b.count += 1;

    if (b.count > max) {
      const retryAfterSec = Math.ceil((b.windowStart + windowMs - now) / 1000);
      res.set('Retry-After', String(retryAfterSec));
      return res.status(429).json({
        error: 'Too many attempts. Please try again later.',
      });
    }
    next();
  };
}

// Test-only: wipe all buckets between tests
function _resetRateLimitsForTests() {
  for (const k of [...buckets.keys()]) {
    if (!k.startsWith('__swept_')) buckets.delete(k);
  }
}

module.exports = { rateLimit, _resetRateLimitsForTests };
