import express from 'express';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';

const app = express();
const PORT = parseInt(process.env.PORT || '3001', 10);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

app.use(express.json());

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', database: 'connected' });
  } catch (err) {
    res.status(503).json({ status: 'unhealthy', database: 'disconnected', error: String(err) });
  }
});

// POST /users — register new user
app.post('/users', async (req, res) => {
  const { fullName, email } = req.body;

  if (!fullName || typeof fullName !== 'string' || fullName.trim().length < 2) {
    return res.status(400).json({ code: 'INVALID_REQUEST', message: 'Full name is required (min 2 characters)' });
  }

  // Check for duplicate email
  if (email) {
    const existing = await pool.query(
      'SELECT id FROM users.users WHERE email = $1',
      [email]
    ).catch(() => ({ rows: [] }));
    if (existing.rows.length > 0) {
      return res.status(409).json({ code: 'DUPLICATE_USER', message: 'A user with this email address is already registered' });
    }
  }

  const userId = `user-${uuidv4()}`;
  const now = new Date();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      'INSERT INTO users.users (id, full_name, email, created_at) VALUES ($1, $2, $3, $4)',
      [userId, fullName.trim(), email || null, now]
    );

    // Generate bearer token
    const rawToken = uuidv4();
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

    await client.query(
      'INSERT INTO users.api_keys (user_id, token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL \'1 year\')',
      [userId, tokenHash]
    );

    await client.query('COMMIT');

    res.status(201).json({
      userId,
      fullName: fullName.trim(),
      email: email || undefined,
      createdAt: now.toISOString(),
      token: rawToken,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error creating user:', err);
    res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Failed to create user' });
  } finally {
    client.release();
  }
});

// GET /users/:userId — get user info
app.get('/users/:userId', async (req, res) => {
  const { userId } = req.params;

  try {
    const result = await pool.query(
      'SELECT id, full_name, email, created_at FROM users.users WHERE id = $1',
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ code: 'USER_NOT_FOUND', message: `User with ID '${userId}' not found` });
    }

    const user = result.rows[0];
    res.json({
      userId: user.id,
      fullName: user.full_name,
      email: user.email || undefined,
      createdAt: user.created_at.toISOString(),
    });
  } catch (err) {
    console.error('Error fetching user:', err);
    res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Failed to fetch user' });
  }
});

// Internal: validate token (called by api-gateway — actually api-gateway queries DB directly)
app.get('/internal/users/:userId/name', async (req, res) => {
  const { userId } = req.params;
  try {
    const result = await pool.query(
      'SELECT full_name FROM users.users WHERE id = $1',
      [userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ code: 'USER_NOT_FOUND', message: 'User not found' });
    }
    res.json({ fullName: result.rows[0].full_name });
  } catch (err) {
    res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Internal error' });
  }
});

app.listen(PORT, () => {
  console.log(`user-service listening on port ${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down...');
  await pool.end();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down...');
  await pool.end();
  process.exit(0);
});
