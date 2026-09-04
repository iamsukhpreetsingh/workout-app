// Minimal fixed-window in-memory rate limiter. Consistent with this
// backend's single-process architecture (no Redis); counters reset on
// restart, which is acceptable for abuse mitigation (not for billing).
// Usage: router.post('/x', rateLimit({ key: 'forgot', max: 5, windowMs: 3600000 }), handler)
//
// The bucket key combines the route key with the client IP (and optionally
// a request attribute like email) so one abuser never locks out others.

const buckets = new Map();

// SECURITY: X-Forwarded-For is client-controllable, so an attacker could
// rotate it to get a fresh rate-limit bucket every request. The socket
// address is unspoofable; XFF is only honoured when the operator explicitly
// declares a trusted proxy with TRUST_XFF=true (then the proxy strips/sets
// the header). Default = trust only the socket.
function clientIp(req) {
  if (String(process.env.TRUST_XFF || '').toLowerCase() === 'true') {
    return (
      req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
      req.socket?.remoteAddress ||
      'unknown'
    );
  }
  return req.socket?.remoteAddress || 'unknown';
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

// ── failure tracker (brute-force guard for credential endpoints) ──────
// Counts only FAILED attempts per (attribute, IP) — successful logins never
// consume budget, so legitimate users and the test suite are unaffected
// while password guessing is cut off after `max` misses per window.
function createFailureTracker({ key, max, windowMs, attributeOf = null }) {
  const bucketFor = (req) => {
    const attr = attributeOf ? String(attributeOf(req) || '').toLowerCase() : '';
    return `${key}:${attr ? attr + '|' : ''}${clientIp(req)}`;
  };
  return {
    // true when the caller has already burned through the failure budget
    blocked(req) {
      const b = buckets.get(bucketFor(req));
      return !!b && b.count >= max && Date.now() - b.windowStart <= windowMs;
    },
    // record one failed attempt
    fail(req) {
      const bucketKey = bucketFor(req);
      const now = Date.now();
      let b = buckets.get(bucketKey);
      if (!b || now - b.windowStart > windowMs) {
        b = { windowStart: now, count: 0 };
        buckets.set(bucketKey, b);
      }
      b.count += 1;
      return b.count >= max;
    },
    // standard middleware that exposes how many attempts remain (429 when out)
    middleware(req, res, next) {
      if (this.blocked(req)) {
        const b = buckets.get(bucketFor(req));
        const retryAfterSec = Math.ceil((b.windowStart + windowMs - Date.now()) / 1000);
        res.set('Retry-After', String(retryAfterSec));
        return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
      }
      next();
    },
  };
}

module.exports = { rateLimit, createFailureTracker, _resetRateLimitsForTests };
