const jwt = require('jsonwebtoken');

// Verifies the JWT on protected routes; attaches { id, role } to req.user.
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing access token' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired access token' });
  }
}

// Role guard for trainer-only endpoints
function requireRole(role) {
  return (req, res, next) => {
    if (!req.user || req.user.role !== role) {
      return res.status(403).json({ error: `This endpoint requires the '${role}' role` });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole };
