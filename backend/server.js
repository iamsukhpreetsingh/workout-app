require('dotenv').config();
const express = require('express');
const cors = require('cors');

const authRoutes = require('./src/routes/auth');
const trainerRoutes = require('./src/routes/trainer');
const clientRoutes = require('./src/routes/client');
const { requireAuth } = require('./src/middleware/auth');
const { getUserById } = require('./src/data/users');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true }));

app.use('/auth', authRoutes);
app.use('/trainer', trainerRoutes);
app.use('/client', clientRoutes);

// GET /me — current user profile (never includes password_hash)
app.get('/me', requireAuth, async (req, res) => {
  const user = await getUserById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`workout-tracker backend listening on :${PORT}`);
});
