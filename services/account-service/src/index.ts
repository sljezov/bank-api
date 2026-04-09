import express from 'express';
import { Pool } from 'pg';

const app = express();
const PORT = parseInt(process.env.PORT || '3002', 10);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const USER_SERVICE_URL = process.env.USER_SERVICE_URL || 'http://user-service:3001';
const BANK_SYNC_SERVICE_URL = process.env.BANK_SYNC_SERVICE_URL || 'http://bank-sync-service:3004';

const SUPPORTED_CURRENCIES = ['EUR', 'USD', 'GBP', 'SEK', 'LVL', 'EEK'];

app.use(express.json());

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', database: 'connected' });
  } catch (err) {
    res.status(503).json({ status: 'unhealthy', database: 'disconnected', error: String(err) });
  }
});

// --- Cent arithmetic helpers (avoid float precision issues) ---
function toCents(amount: string): number {
  const [whole, frac = ''] = amount.split('.');
  return parseInt(whole, 10) * 100 + parseInt(frac.padEnd(2, '0').slice(0, 2), 10);
}

function fromCents(cents: number): string {
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  return `${cents < 0 ? '-' : ''}${whole}.${frac.toString().padStart(2, '0')}`;
}

// --- Dynamic bank prefix (fetched from bank-sync, 30s cache) ---
let prefixCache: { value: string; expiresAt: number } | null = null;

async function getBankPrefix(): Promise<string> {
  if (prefixCache && Date.now() < prefixCache.expiresAt) {
    return prefixCache.value;
  }
  try {
    const res = await fetch(`${BANK_SYNC_SERVICE_URL}/internal/bank-info`);
    if (res.ok) {
      const data = await res.json() as { prefix: string };
      if (/^[A-Z0-9]{3}$/.test(data.prefix)) {
        prefixCache = { value: data.prefix, expiresAt: Date.now() + 30_000 };
        return data.prefix;
      }
    }
  } catch {
    // fall through to cached or UNK
  }
  return prefixCache?.value ?? 'UNK';
}

// Keep set-bank-prefix for backward compat — now also warms cache
app.post('/internal/set-bank-prefix', (req, res) => {
  const { prefix } = req.body;
  if (prefix && typeof prefix === 'string' && /^[A-Z0-9]{3}$/.test(prefix)) {
    prefixCache = { value: prefix, expiresAt: Date.now() + 30_000 };
    console.log(`Bank prefix set to: ${prefix}`);
    res.json({ ok: true });
  } else {
    res.status(400).json({ code: 'INVALID_PREFIX', message: 'Invalid bank prefix' });
  }
});

async function generateAccountNumber(): Promise<string> {
  const prefix = await getBankPrefix();
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let suffix = '';
  for (let i = 0; i < 5; i++) {
    suffix += chars[Math.floor(Math.random() * chars.length)];
  }
  return `${prefix}${suffix}`;
}

// POST /accounts
app.post('/accounts', async (req, res) => {
  const authenticatedUserId = req.headers['x-user-id'] as string;
  const pathUserId = req.headers['x-path-user-id'] as string;
  const { currency } = req.body;

  if (!authenticatedUserId) {
    return res.status(401).json({ code: 'UNAUTHORIZED', message: 'Authentication required' });
  }

  if (pathUserId && pathUserId !== authenticatedUserId) {
    return res.status(403).json({ code: 'FORBIDDEN', message: 'Cannot create account for another user' });
  }

  const effectiveUserId = authenticatedUserId;

  if (!currency || typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
    return res.status(400).json({ code: 'INVALID_REQUEST', message: 'Currency is required and must be a valid ISO 4217 code' });
  }

  if (!SUPPORTED_CURRENCIES.includes(currency.toUpperCase())) {
    return res.status(400).json({ code: 'UNSUPPORTED_CURRENCY', message: `Currency '${currency}' is not supported by this bank` });
  }

  try {
    const userRes = await fetch(`${USER_SERVICE_URL}/users/${effectiveUserId}`);
    if (!userRes.ok) {
      return res.status(404).json({ code: 'USER_NOT_FOUND', message: `User with ID '${effectiveUserId}' not found` });
    }
  } catch {
    return res.status(503).json({ code: 'SERVICE_UNAVAILABLE', message: 'User service unavailable' });
  }

  let accountNumber = await generateAccountNumber();
  let attempts = 0;
  while (attempts < 10) {
    const existing = await pool.query(
      'SELECT account_number FROM accounts.accounts WHERE account_number = $1',
      [accountNumber]
    );
    if (existing.rows.length === 0) break;
    accountNumber = await generateAccountNumber();
    attempts++;
  }

  const now = new Date();

  try {
    await pool.query(
      'INSERT INTO accounts.accounts (account_number, user_id, currency, balance, created_at) VALUES ($1, $2, $3, $4, $5)',
      [accountNumber, effectiveUserId, currency, '0.00', now]
    );

    res.status(201).json({
      accountNumber,
      ownerId: effectiveUserId,
      currency,
      balance: '0.00',
      createdAt: now.toISOString(),
    });
  } catch (err) {
    console.error('Error creating account:', err);
    res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Failed to create account' });
  }
});

// GET /accounts/:accountNumber — public lookup
app.get('/accounts/:accountNumber', async (req, res) => {
  const { accountNumber } = req.params;

  if (!/^[A-Z0-9]{8}$/.test(accountNumber)) {
    return res.status(400).json({ code: 'INVALID_ACCOUNT_NUMBER', message: 'Account number must be exactly 8 uppercase alphanumeric characters' });
  }

  try {
    const result = await pool.query(
      'SELECT a.account_number, a.user_id, a.currency FROM accounts.accounts a WHERE a.account_number = $1',
      [accountNumber]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ code: 'ACCOUNT_NOT_FOUND', message: `Account with number '${accountNumber}' not found` });
    }

    const account = result.rows[0];
    let ownerName = 'Unknown';
    try {
      const userRes = await fetch(`${USER_SERVICE_URL}/users/${account.user_id}`);
      if (userRes.ok) {
        const user = await userRes.json() as { fullName: string };
        ownerName = user.fullName;
      }
    } catch {
      // proceed with unknown name
    }

    res.json({
      accountNumber: account.account_number,
      ownerName,
      currency: account.currency,
    });
  } catch (err) {
    console.error('Error looking up account:', err);
    res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Failed to look up account' });
  }
});

// Internal: atomic same-bank transfer (debit + credit in one DB transaction)
app.post('/internal/accounts/transfer', async (req, res) => {
  const { sourceAccount, destinationAccount, amount, convertedAmount } = req.body;
  const debitAmount = amount as string;
  const creditAmount = (convertedAmount || amount) as string;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock both accounts in consistent order to prevent deadlocks
    const [lockA, lockB] = [sourceAccount, destinationAccount].sort();
    await client.query(
      'SELECT balance FROM accounts.accounts WHERE account_number = ANY($1) FOR UPDATE',
      [[lockA, lockB]]
    );

    const srcResult = await client.query(
      'SELECT balance, currency FROM accounts.accounts WHERE account_number = $1',
      [sourceAccount]
    );

    if (srcResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ code: 'ACCOUNT_NOT_FOUND', message: `Source account '${sourceAccount}' not found` });
    }

    const dstResult = await client.query(
      'SELECT balance FROM accounts.accounts WHERE account_number = $1',
      [destinationAccount]
    );

    if (dstResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ code: 'ACCOUNT_NOT_FOUND', message: `Destination account '${destinationAccount}' not found` });
    }

    const srcBalanceCents = toCents(srcResult.rows[0].balance.toString());
    const debitCents = toCents(debitAmount);

    if (srcBalanceCents < debitCents) {
      await client.query('ROLLBACK');
      return res.status(422).json({ code: 'INSUFFICIENT_FUNDS', message: 'Insufficient funds in source account' });
    }

    const newSrcBalance = fromCents(srcBalanceCents - debitCents);
    const dstBalanceCents = toCents(dstResult.rows[0].balance.toString());
    const creditCents = toCents(creditAmount);
    const newDstBalance = fromCents(dstBalanceCents + creditCents);

    await client.query(
      'UPDATE accounts.accounts SET balance = $1 WHERE account_number = $2',
      [newSrcBalance, sourceAccount]
    );
    await client.query(
      'UPDATE accounts.accounts SET balance = $1 WHERE account_number = $2',
      [newDstBalance, destinationAccount]
    );

    await client.query('COMMIT');
    res.json({ ok: true, sourceBalance: newSrcBalance, destinationBalance: newDstBalance, currency: srcResult.rows[0].currency });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Atomic transfer error:', err);
    res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Transfer failed' });
  } finally {
    client.release();
  }
});

// Internal: debit account
app.post('/internal/accounts/:accountNumber/debit', async (req, res) => {
  const { accountNumber } = req.params;
  const { amount } = req.body;

  if (!amount || isNaN(toCents(amount))) {
    return res.status(400).json({ code: 'INVALID_AMOUNT', message: 'Valid amount required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const result = await client.query(
      'SELECT balance, currency FROM accounts.accounts WHERE account_number = $1 FOR UPDATE',
      [accountNumber]
    );

    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ code: 'ACCOUNT_NOT_FOUND', message: `Account '${accountNumber}' not found` });
    }

    const balanceCents = toCents(result.rows[0].balance.toString());
    const debitCents = toCents(amount);

    if (balanceCents < debitCents) {
      await client.query('ROLLBACK');
      return res.status(422).json({ code: 'INSUFFICIENT_FUNDS', message: 'Insufficient funds in source account' });
    }

    const newBalance = fromCents(balanceCents - debitCents);
    await client.query(
      'UPDATE accounts.accounts SET balance = $1 WHERE account_number = $2',
      [newBalance, accountNumber]
    );

    await client.query('COMMIT');
    res.json({ balance: newBalance, currency: result.rows[0].currency });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Debit error:', err);
    res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Debit failed' });
  } finally {
    client.release();
  }
});

// Internal: credit account
app.post('/internal/accounts/:accountNumber/credit', async (req, res) => {
  const { accountNumber } = req.params;
  const { amount } = req.body;

  if (!amount || isNaN(toCents(amount))) {
    return res.status(400).json({ code: 'INVALID_AMOUNT', message: 'Valid amount required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const result = await client.query(
      'SELECT balance FROM accounts.accounts WHERE account_number = $1 FOR UPDATE',
      [accountNumber]
    );

    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ code: 'ACCOUNT_NOT_FOUND', message: `Account '${accountNumber}' not found` });
    }

    const newBalance = fromCents(toCents(result.rows[0].balance.toString()) + toCents(amount));
    await client.query(
      'UPDATE accounts.accounts SET balance = $1 WHERE account_number = $2',
      [newBalance, accountNumber]
    );

    await client.query('COMMIT');
    res.json({ balance: newBalance });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Credit error:', err);
    res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Credit failed' });
  } finally {
    client.release();
  }
});

// Internal: get account details
app.get('/internal/accounts/:accountNumber', async (req, res) => {
  const { accountNumber } = req.params;

  try {
    const result = await pool.query(
      'SELECT account_number, user_id, currency, balance FROM accounts.accounts WHERE account_number = $1',
      [accountNumber]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ code: 'ACCOUNT_NOT_FOUND', message: `Account '${accountNumber}' not found` });
    }

    const account = result.rows[0];
    res.json({
      accountNumber: account.account_number,
      userId: account.user_id,
      currency: account.currency,
      balance: account.balance.toString(),
    });
  } catch (err) {
    res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Internal error' });
  }
});

app.listen(PORT, () => {
  console.log(`account-service listening on port ${PORT}`);
});

process.on('SIGTERM', async () => {
  await pool.end();
  process.exit(0);
});

process.on('SIGINT', async () => {
  await pool.end();
  process.exit(0);
});
