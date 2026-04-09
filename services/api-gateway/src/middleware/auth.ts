import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { Pool, PoolClient } from 'pg';

let pool: Pool | null = null;

function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });
  }
  return pool;
}

// These paths don't require authentication
const PUBLIC_PATHS: Array<{ method: string; pattern: RegExp }> = [
  { method: 'POST', pattern: /^\/users$/ },
  { method: 'GET', pattern: /^\/accounts\/[^/]+$/ },
  { method: 'POST', pattern: /^\/transfers\/receive$/ },
  { method: 'GET', pattern: /^\/api-docs/ },
];

function isPublicPath(method: string, path: string): boolean {
  return PUBLIC_PATHS.some(
    (p) => p.method === method && p.pattern.test(path)
  );
}

export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (isPublicPath(req.method, req.path)) {
    return next();
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ code: 'UNAUTHORIZED', message: 'Bearer token required' });
    return;
  }

  const token = authHeader.slice(7);
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

  try {
    const result = await getPool().query(
      'SELECT user_id, expires_at FROM users.api_keys WHERE token_hash = $1',
      [tokenHash]
    );

    if (result.rows.length === 0) {
      res.status(401).json({ code: 'UNAUTHORIZED', message: 'Invalid or expired token' });
      return;
    }

    const { expires_at } = result.rows[0];
    if (expires_at && new Date(expires_at) < new Date()) {
      res.status(401).json({ code: 'TOKEN_EXPIRED', message: 'Token has expired' });
      return;
    }

    req.headers['x-user-id'] = result.rows[0].user_id;
    next();
  } catch (err) {
    console.error('Auth middleware error:', err);
    res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Authentication service error' });
  }
}

export async function closeAuthPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
