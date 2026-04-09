import express from 'express';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { ensureRegistered, BankRegistration, isCurrencySupported, SUPPORTED_CURRENCIES } from './registration';
import { startHeartbeat } from './heartbeat';
import { importPKCS8, SignJWT } from 'jose';

const app = express();
const PORT = parseInt(process.env.PORT || '3004', 10);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const redis = new Redis(process.env.REDIS_URL || 'redis://redis:6379');

const CENTRAL_BANK_URL = process.env.CENTRAL_BANK_URL || 'https://test.diarainfra.com/central-bank';
const ACCOUNT_SERVICE_URL = process.env.ACCOUNT_SERVICE_URL || 'http://account-service:3002';

app.use(express.json());

app.get('/health', async (_req, res) => {
  const health: Record<string, string> = { status: 'ok' };
  let healthy = true;

  try {
    await pool.query('SELECT 1');
    health.database = 'connected';
  } catch (err) {
    healthy = false;
    health.database = 'disconnected';
  }

  try {
    await redis.ping();
    health.redis = 'connected';
  } catch (err) {
    healthy = false;
    health.redis = 'disconnected';
  }

  if (!registrationRef.current.bankId) {
    healthy = false;
    health.registration = 'not registered';
  } else {
    health.registration = 'registered';
  }

  res.status(healthy ? 200 : 503).json(health);
});

// Shared mutable registration reference
const registrationRef: { current: BankRegistration } = {
  current: { bankId: '', privateKey: '', publicKey: '', name: '', address: '' }
};

// Internal: get our bank info
app.get('/internal/bank-info', (_req, res) => {
  if (!registrationRef.current.bankId) {
    return res.status(503).json({ code: 'NOT_REGISTERED', message: 'Bank not yet registered' });
  }
  res.json({
    bankId: registrationRef.current.bankId,
    prefix: registrationRef.current.bankId.slice(0, 3),
    publicKey: registrationRef.current.publicKey,
    address: registrationRef.current.address,
  });
});

// Internal: get bank directory (for transfer routing)
app.get('/internal/banks', async (_req, res) => {
  try {
    // Try Redis cache first (fail open if Redis is down)
    try {
      const cached = await redis.get('bank_directory');
      if (cached) return res.json(JSON.parse(cached));
    } catch {
      console.warn('Redis unavailable, falling back to DB for bank directory');
    }

    // Fall back to DB
    const result = await pool.query(
      'SELECT bank_id, name, address, public_key FROM bank_sync.bank_directory'
    );
    const banks = result.rows.map(r => ({
      bankId: r.bank_id,
      name: r.name,
      address: r.address,
      publicKey: r.public_key,
    }));
    res.json(banks);
  } catch (err) {
    res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Failed to fetch bank directory' });
  }
});

// Internal: get specific bank by ID
// Pass ?fresh=true to bypass cache and re-fetch from central bank (used when JWT verification fails)
app.get('/internal/banks/:bankId', async (req, res) => {
  const { bankId } = req.params;
  const fresh = req.query.fresh === 'true';

  try {
    if (!fresh) {
      // Check Redis cache
      const cached = await redis.get('bank_directory');
      if (cached) {
        const banks = JSON.parse(cached) as Array<{ bankId: string; name: string; address: string; publicKey: string }>;
        const bank = banks.find(b => b.bankId === bankId);
        if (bank) return res.json(bank);
      }

      // Check DB
      const result = await pool.query(
        'SELECT bank_id, name, address, public_key FROM bank_sync.bank_directory WHERE bank_id = $1',
        [bankId]
      );

      if (result.rows.length > 0) {
        const row = result.rows[0];
        return res.json({
          bankId: row.bank_id,
          name: row.name,
          address: row.address,
          publicKey: row.public_key,
        });
      }
    }

    // Fetch fresh from central bank
    const cbRes = await fetch(`${CENTRAL_BANK_URL}/api/v1/banks/${bankId}`);
    if (!cbRes.ok) {
      return res.status(404).json({ code: 'BANK_NOT_FOUND', message: `Bank '${bankId}' not found` });
    }
    const bankData = await cbRes.json() as { bankId: string; name: string; address: string; publicKey: string };

    // Update DB with fresh data
    await pool.query(
      `INSERT INTO bank_sync.bank_directory (bank_id, name, address, public_key, synced_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (bank_id) DO UPDATE SET
         name = $2, address = $3, public_key = $4, synced_at = NOW()`,
      [bankData.bankId, bankData.name, bankData.address, bankData.publicKey]
    );

    // Invalidate directory cache so next bulk fetch is fresh
    try { await redis.del('bank_directory'); } catch { /* Redis down, continue */ }

    return res.json({
      bankId: bankData.bankId,
      name: bankData.name,
      address: bankData.address,
      publicKey: bankData.publicKey,
    });
  } catch (err) {
    res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Failed to fetch bank' });
  }
});

// Internal: get exchange rates
app.get('/internal/exchange-rates', async (_req, res) => {
  try {
    // Check Redis cache (10 min TTL) — fail open if Redis is down
    try {
      const cached = await redis.get('exchange_rates');
      if (cached) return res.json(JSON.parse(cached));
    } catch {
      console.warn('Redis unavailable, fetching exchange rates directly');
    }

    // Fetch from central bank
    const cbRes = await fetch(`${CENTRAL_BANK_URL}/api/v1/exchange-rates`);
    if (!cbRes.ok) {
      return res.status(503).json({ code: 'CENTRAL_BANK_UNAVAILABLE', message: 'Central bank unavailable' });
    }

    const data = await cbRes.json();
    try {
      await redis.setex('exchange_rates', 600, JSON.stringify(data)); // 10 min cache
      await redis.setex('exchange_rates_fallback', 86400, JSON.stringify(data)); // 24h fallback
    } catch {
      console.warn('Redis unavailable, could not cache exchange rates');
    }
    res.json(data);
  } catch (err) {
    // Try fallback cache
    try {
      const cached = await redis.get('exchange_rates_fallback');
      if (cached) return res.json(JSON.parse(cached));
    } catch {}
    res.status(503).json({ code: 'CENTRAL_BANK_UNAVAILABLE', message: 'Exchange rates unavailable' });
  }
});

// Internal: sign a JWT for inter-bank transfer
app.post('/internal/sign-jwt', async (req, res) => {
  const { payload } = req.body;

  if (!registrationRef.current.privateKey) {
    return res.status(503).json({ code: 'NOT_REGISTERED', message: 'Bank not registered' });
  }

  try {
    const privateKey = await importPKCS8(registrationRef.current.privateKey, 'ES256');
    const jwt = await new SignJWT(payload)
      .setProtectedHeader({ alg: 'ES256' })
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);

    res.json({ jwt });
  } catch (err) {
    console.error('JWT signing error:', err);
    res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Failed to sign JWT' });
  }
});

// Internal: check if currency is supported
app.get('/internal/supported-currencies', (_req, res) => {
  res.json({ currencies: SUPPORTED_CURRENCIES });
});

// Sync bank directory from central bank
async function syncBankDirectory(): Promise<void> {
  try {
    const response = await fetch(`${CENTRAL_BANK_URL}/api/v1/banks`);
    if (!response.ok) {
      console.error('Failed to sync bank directory:', response.status);
      return;
    }

    const data = await response.json() as { banks: Array<{ bankId: string; name: string; address: string; publicKey: string; lastHeartbeat: string }> };
    const banks = data.banks;

    // Update Redis cache
    const cacheData = banks.map(b => ({
      bankId: b.bankId,
      name: b.name,
      address: b.address,
      publicKey: b.publicKey,
    }));
    await redis.setex('bank_directory', 3600, JSON.stringify(cacheData)); // 1h cache

    // Update DB
    for (const bank of banks) {
      await pool.query(
        `INSERT INTO bank_sync.bank_directory (bank_id, name, address, public_key, last_heartbeat, synced_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (bank_id) DO UPDATE SET
           name = $2, address = $3, public_key = $4, last_heartbeat = $5, synced_at = NOW()`,
        [bank.bankId, bank.name, bank.address, bank.publicKey, bank.lastHeartbeat || null]
      );
    }

    console.log(`Synced ${banks.length} banks from central bank`);
  } catch (err) {
    console.error('Bank directory sync error:', err);
  }
}

async function notifyAccountServicePrefix(prefix: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const res = await fetch(`${ACCOUNT_SERVICE_URL}/internal/set-bank-prefix`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefix }),
      });
      if (res.ok) {
        console.log(`Notified account-service of prefix: ${prefix}`);
        return;
      }
    } catch {
      // retry
    }
    console.log(`Retrying account-service prefix notification... (attempt ${attempt + 1})`);
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  console.error('Failed to notify account-service of prefix after retries');
}

async function registerWithRetry(): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const registration = await ensureRegistered(pool);
      registrationRef.current = registration;
      console.log(`Bank registered as: ${registration.bankId}`);
      console.log(`Bank prefix: ${registration.bankId.slice(0, 3)}`);

      await notifyAccountServicePrefix(registration.bankId.slice(0, 3));
      startHeartbeat(pool, registrationRef);
      await syncBankDirectory();
      setInterval(syncBankDirectory, 5 * 60 * 1000);
      return;
    } catch (err) {
      console.error(`Registration attempt ${attempt + 1} failed:`, err);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
  console.error('Could not register with Central Bank after retries. Bank prefix will remain unknown.');
}

// Startup: listen first so health check passes, then register in background
let server = app.listen(PORT, () => {
  console.log(`bank-sync-service listening on port ${PORT}`);
  // Delay slightly to let DB connections stabilize
  setTimeout(registerWithRetry, 2000);
});

// Graceful shutdown
const gracefulShutdown = async (signal: string) => {
  console.log(`Received ${signal}, shutting down...`);
  
  if (server) {
    server.close(async () => {
      console.log('HTTP server closed');
      await pool.end();
      await redis.quit();
      console.log('Database and Redis connections closed');
      process.exit(0);
    });
    
    setTimeout(() => {
      console.error('Forced shutdown');
      process.exit(1);
    }, 10000);
  }
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
