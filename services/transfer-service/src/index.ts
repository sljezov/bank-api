import express from 'express';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { Queue } from 'bullmq';
import { startRetryWorker } from './retry-worker';
import { sendCrossBankTransfer, verifyIncomingJWT, DestinationBankUnavailableError } from './cross-bank';

const app = express();
const PORT = parseInt(process.env.PORT || '3003', 10);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379';
const ACCOUNT_SERVICE_URL = process.env.ACCOUNT_SERVICE_URL || 'http://account-service:3002';
const BANK_SYNC_SERVICE_URL = process.env.BANK_SYNC_SERVICE_URL || 'http://bank-sync-service:3004';

// Parse redis URL for BullMQ connection
function parseRedisConnection(url: string): { host: string; port: number } {
  const parsed = new URL(url.startsWith('redis://') ? url : `redis://${url}`);
  return { host: parsed.hostname, port: parseInt(parsed.port || '6379', 10) };
}

const redisConnection = parseRedisConnection(REDIS_URL);
const retryQueue = new Queue('transfer-retry', { connection: redisConnection });
const redis = new Redis(REDIS_URL);

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

  res.status(healthy ? 200 : 503).json(health);
});

// Get our bank prefix
async function getOurBankPrefix(): Promise<string> {
  const res = await fetch(`${BANK_SYNC_SERVICE_URL}/internal/bank-info`);
  if (!res.ok) throw new Error('Failed to get bank info');
  const data = await res.json() as { prefix: string };
  return data.prefix;
}

// Determine if account is ours based on prefix
async function isOurAccount(accountNumber: string): Promise<boolean> {
  try {
    const prefix = await getOurBankPrefix();
    return accountNumber.startsWith(prefix);
  } catch {
    return false;
  }
}

// Find which bank an account belongs to (for cross-bank routing)
async function findDestinationBank(accountNumber: string): Promise<{ bankId: string; address: string } | null> {
  const prefix = accountNumber.slice(0, 3);

  // Check all registered banks
  const banksRes = await fetch(`${BANK_SYNC_SERVICE_URL}/internal/banks`);
  if (!banksRes.ok) return null;

  const banks = await banksRes.json() as Array<{ bankId: string; address: string }>;
  const bank = banks.find(b => b.bankId.startsWith(prefix));
  return bank || null;
}

// POST /transfers — initiate transfer
app.post('/transfers', async (req, res) => {
  const userId = req.headers['x-user-id'] as string;

  if (!userId) {
    return res.status(401).json({ code: 'UNAUTHORIZED', message: 'Authentication required' });
  }

  const { transferId, sourceAccount, destinationAccount, amount } = req.body;

  // Validate inputs
  if (!transferId || !sourceAccount || !destinationAccount || !amount) {
    return res.status(400).json({ code: 'INVALID_REQUEST', message: 'transferId, sourceAccount, destinationAccount, and amount are required' });
  }

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(transferId)) {
    return res.status(400).json({ code: 'INVALID_REQUEST', message: 'transferId must be a valid UUID' });
  }

  if (!/^[A-Z0-9]{8}$/.test(sourceAccount) || !/^[A-Z0-9]{8}$/.test(destinationAccount)) {
    return res.status(400).json({ code: 'INVALID_REQUEST', message: 'Account numbers must be 8 uppercase alphanumeric characters' });
  }

  if (!/^\d+\.\d{2}$/.test(amount) || parseFloat(amount) <= 0) {
    return res.status(400).json({ code: 'INVALID_REQUEST', message: 'Amount must be a positive decimal with 2 decimal places' });
  }

  // Check for idempotency
  const existing = await pool.query(
    'SELECT transfer_id, status FROM transfers.transfers WHERE transfer_id = $1',
    [transferId]
  );

  if (existing.rows.length > 0) {
    const existingTransfer = existing.rows[0];
    if (existingTransfer.status === 'pending') {
      return res.status(409).json({
        code: 'TRANSFER_ALREADY_PENDING',
        message: `Transfer with ID '${transferId}' is already pending. Cannot submit duplicate transfer.`
      });
    }
    return res.status(409).json({
      code: 'DUPLICATE_TRANSFER',
      message: `A transfer with ID '${transferId}' already exists`
    });
  }

  // Validate source account exists and belongs to this user
  const srcAccountRes = await fetch(
    `${ACCOUNT_SERVICE_URL}/internal/accounts/${sourceAccount}`
  );

  if (!srcAccountRes.ok) {
    return res.status(404).json({ code: 'ACCOUNT_NOT_FOUND', message: `Source account '${sourceAccount}' not found` });
  }

  const srcAccount = await srcAccountRes.json() as { userId: string; currency: string; balance: string };

  if (srcAccount.userId !== userId) {
    return res.status(403).json({ code: 'FORBIDDEN', message: 'Source account does not belong to authenticated user' });
  }

  // Determine routing
  const isSameBank = await isOurAccount(destinationAccount);
  const now = new Date();

  if (isSameBank) {
    // Same-bank transfer
    // Validate destination account exists
    const dstAccountRes = await fetch(
      `${ACCOUNT_SERVICE_URL}/internal/accounts/${destinationAccount}`
    );
    if (!dstAccountRes.ok) {
      return res.status(404).json({ code: 'ACCOUNT_NOT_FOUND', message: `Destination account '${destinationAccount}' not found` });
    }
    const dstAccount = await dstAccountRes.json() as { currency: string };

    // Calculate exchange rate if currencies differ
    let finalAmount = amount;
    let exchangeRate: string | null = null;
    let convertedAmount: string | null = null;
    let rateCapturedAt: string | null = null;

    if (srcAccount.currency !== dstAccount.currency) {
      try {
        const ratesRes = await fetch(`${BANK_SYNC_SERVICE_URL}/internal/exchange-rates`);
        if (!ratesRes.ok) throw new Error('Exchange rates unavailable');
        const rates = await ratesRes.json() as { rates: Record<string, string>; timestamp: string };

        const srcRate = parseFloat(rates.rates[srcAccount.currency] || '1');
        const dstRate = parseFloat(rates.rates[dstAccount.currency] || '1');
        const rate = dstRate / srcRate;
        exchangeRate = rate.toFixed(6);
        convertedAmount = (parseFloat(amount) * rate).toFixed(2);
        finalAmount = convertedAmount;
        rateCapturedAt = rates.timestamp;
      } catch {
        return res.status(503).json({ code: 'CENTRAL_BANK_UNAVAILABLE', message: 'Cannot get exchange rates for currency conversion' });
      }
    }

    // Atomic debit+credit in a single DB transaction via account-service
    const atomicRes = await fetch(
      `${ACCOUNT_SERVICE_URL}/internal/accounts/transfer`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceAccount, destinationAccount, amount, convertedAmount: finalAmount }),
      }
    );

    if (!atomicRes.ok) {
      const errBody = await atomicRes.json() as { code: string; message: string };
      return res.status(atomicRes.status).json(errBody);
    }

    // Record transfer
    await pool.query(
      `INSERT INTO transfers.transfers
       (transfer_id, sender_account, receiver_account, amount, currency, status,
        is_cross_bank, exchange_rate, converted_amount, rate_captured_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'completed', false, $6, $7, $8, $9, $9)`,
      [transferId, sourceAccount, destinationAccount, amount, srcAccount.currency,
       exchangeRate, convertedAmount, rateCapturedAt, now]
    );

    const response: Record<string, unknown> = {
      transferId,
      status: 'completed',
      sourceAccount,
      destinationAccount,
      amount,
      timestamp: now.toISOString(),
    };

    if (exchangeRate) {
      response.convertedAmount = convertedAmount;
      response.exchangeRate = exchangeRate;
      response.rateCapturedAt = rateCapturedAt;
    }

    return res.status(201).json(response);
  } else {
    // Cross-bank transfer
    const destBank = await findDestinationBank(destinationAccount);

    if (!destBank) {
      return res.status(404).json({ code: 'ACCOUNT_NOT_FOUND', message: `Cannot find bank for account '${destinationAccount}'` });
    }

    // Get destination account info for currency
    let dstCurrency = srcAccount.currency; // assume same unless we know otherwise
    let exchangeRate: string | null = null;
    let convertedAmount: string | null = null;
    let rateCapturedAt: string | null = null;

    // Try to get destination account info (may fail if account doesn't exist yet or is on different bank)
    try {
      const dstUrl = destBank.address.replace(/\/+$/, '');
      const dstLookupRes = await fetch(`${dstUrl}/accounts/${destinationAccount}`);
      if (dstLookupRes.ok) {
        const dstAccInfo = await dstLookupRes.json() as { currency: string };
        dstCurrency = dstAccInfo.currency;
      }
    } catch {
      // proceed without destination currency info - same currency assumed
    }

    if (srcAccount.currency !== dstCurrency) {
      try {
        const ratesRes = await fetch(`${BANK_SYNC_SERVICE_URL}/internal/exchange-rates`);
        if (!ratesRes.ok) throw new Error('Exchange rates unavailable');
        const rates = await ratesRes.json() as { rates: Record<string, string>; timestamp: string };

        const srcRate = parseFloat(rates.rates[srcAccount.currency] || '1');
        const dstRate = parseFloat(rates.rates[dstCurrency] || '1');
        const rate = dstRate / srcRate;
        exchangeRate = rate.toFixed(6);
        convertedAmount = (parseFloat(amount) * rate).toFixed(2);
        rateCapturedAt = rates.timestamp;
      } catch {
        return res.status(503).json({ code: 'CENTRAL_BANK_UNAVAILABLE', message: 'Cannot get exchange rates for cross-bank transfer' });
      }
    }

    // Debit source account first
    const debitRes = await fetch(
      `${ACCOUNT_SERVICE_URL}/internal/accounts/${sourceAccount}/debit`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount }),
      }
    );

    if (!debitRes.ok) {
      const errBody = await debitRes.json() as { code: string; message: string };
      return res.status(debitRes.status).json(errBody);
    }

    const expiresAt = new Date(now.getTime() + 4 * 60 * 60 * 1000); // 4 hours

    // Insert transfer record as pending
    await pool.query(
      `INSERT INTO transfers.transfers
       (transfer_id, sender_account, receiver_account, amount, currency, status,
        is_cross_bank, destination_bank_id, exchange_rate, converted_amount, rate_captured_at,
        retry_count, next_retry_at, expires_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'pending', true, $6, $7, $8, $9, 0, $10, $11, $12, $12)`,
      [
        transferId, sourceAccount, destinationAccount, amount, srcAccount.currency,
        destBank.bankId, exchangeRate, convertedAmount, rateCapturedAt,
        new Date(now.getTime() + 60 * 1000), // first retry in 1 minute
        expiresAt, now
      ]
    );

    // Try to send immediately
    try {
      await sendCrossBankTransfer(pool, {
        transfer_id: transferId,
        sender_account: sourceAccount,
        receiver_account: destinationAccount,
        amount,
        currency: srcAccount.currency,
        destination_bank_id: destBank.bankId,
        exchange_rate: exchangeRate,
        converted_amount: convertedAmount,
      });

      // Success
      await pool.query(
        `UPDATE transfers.transfers
         SET status = 'completed', updated_at = NOW(), next_retry_at = NULL
         WHERE transfer_id = $1`,
        [transferId]
      );

      const response: Record<string, unknown> = {
        transferId,
        status: 'completed',
        sourceAccount,
        destinationAccount,
        amount,
        timestamp: now.toISOString(),
      };

      if (exchangeRate) {
        response.convertedAmount = convertedAmount;
        response.exchangeRate = exchangeRate;
        response.rateCapturedAt = rateCapturedAt;
      }

      return res.status(201).json(response);
    } catch (err) {
      console.error(`Cross-bank transfer failed, queuing retry: ${err}`);

      // Check if destination was unavailable - if so, queue for retry
      const isDestinationUnavailable = err instanceof DestinationBankUnavailableError;
      
      if (isDestinationUnavailable) {
        // Queue retry
        const delay = 60 * 1000; // 1 minute initial delay
        await retryQueue.add('retry', { transferId }, { delay });

        const response: Record<string, unknown> = {
          transferId,
          status: 'pending',
          sourceAccount,
          destinationAccount,
          amount,
          timestamp: now.toISOString(),
        };

        if (exchangeRate) {
          response.convertedAmount = convertedAmount;
          response.exchangeRate = exchangeRate;
          response.rateCapturedAt = rateCapturedAt;
        }

        return res.status(503).json({
          code: 'DESTINATION_BANK_UNAVAILABLE',
          message: 'Destination bank is temporarily unavailable. Transfer has been queued for retry.',
          ...response,
        });
      }

      // For other errors (rejection, etc.), refund the sender and mark as failed
      console.error(`Cross-bank transfer permanently failed: ${err}. Refunding sender.`);
      
      await pool.query(
        `UPDATE transfers.transfers
         SET status = 'failed', updated_at = NOW(), error_message = $1
         WHERE transfer_id = $2`,
        [`Transfer failed: ${err instanceof Error ? err.message : 'Unknown error'}`, transferId]
      );

      // Refund the sender
      await fetch(
        `${ACCOUNT_SERVICE_URL}/internal/accounts/${sourceAccount}/credit`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ amount }),
        }
      );

      return res.status(400).json({
        code: 'TRANSFER_FAILED',
        message: `Transfer failed: ${err instanceof Error ? err.message : 'Unknown error'}. Funds have been refunded.`,
      });
    }
  }
});

// POST /transfers/receive — receive inter-bank transfer
app.post('/transfers/receive', async (req, res) => {
  const { jwt } = req.body;

  if (!jwt) {
    return res.status(400).json({ code: 'INVALID_REQUEST', message: 'JWT is required' });
  }

  let payload: Awaited<ReturnType<typeof verifyIncomingJWT>>;
  try {
    payload = await verifyIncomingJWT(jwt);
  } catch (err) {
    console.error('JWT verification failed:', err instanceof Error ? err.message : err);
    return res.status(401).json({ code: 'UNAUTHORIZED', message: 'Invalid JWT' });
  }

  try {
    const { transferId, destinationAccount, amount } = payload;

    // Check if we already processed this transfer (idempotency)
    const existing = await pool.query(
      'SELECT transfer_id, status FROM transfers.transfers WHERE transfer_id = $1',
      [transferId]
    );

    if (existing.rows.length > 0) {
      const t = existing.rows[0];
      return res.json({
        transferId: t.transfer_id,
        status: t.status,
        destinationAccount,
        amount,
        timestamp: new Date().toISOString(),
      });
    }

    // Credit the destination account
    const creditRes = await fetch(
      `${ACCOUNT_SERVICE_URL}/internal/accounts/${destinationAccount}/credit`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount }),
      }
    );

    if (!creditRes.ok) {
      const errBody = await creditRes.json() as { code: string; message: string };
      return res.status(creditRes.status).json(errBody);
    }

    const now = new Date();

    // Record as completed transfer
    await pool.query(
      `INSERT INTO transfers.transfers
       (transfer_id, sender_account, receiver_account, amount, currency, status,
        is_cross_bank, destination_bank_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'completed', true, $6, $7, $7)`,
      [transferId, payload.sourceAccount, destinationAccount, amount,
       (payload as Record<string, unknown>).currency || 'EUR',
       payload.sourceBankId, now]
    );

    res.json({
      transferId,
      status: 'completed',
      destinationAccount,
      amount,
      timestamp: now.toISOString(),
    });
  } catch (err) {
    console.error('Error receiving inter-bank transfer:', err);
    res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Failed to process transfer' });
  }
});

// GET /transfers/:transferId — get transfer status
app.get('/transfers/:transferId', async (req, res) => {
  const userId = req.headers['x-user-id'] as string;

  if (!userId) {
    return res.status(401).json({ code: 'UNAUTHORIZED', message: 'Authentication required' });
  }

  const { transferId } = req.params;

  try {
    const result = await pool.query(
      'SELECT * FROM transfers.transfers WHERE transfer_id = $1',
      [transferId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ code: 'TRANSFER_NOT_FOUND', message: `Transfer with ID '${transferId}' not found` });
    }

    const t = result.rows[0];

    // Return 423 Locked if transfer has timed out
    if (t.status === 'failed_timeout') {
      return res.status(423).json({
        code: 'TRANSFER_TIMEOUT',
        message: 'Transfer has timed out and cannot be modified or retried. Status is failed_timeout with refund processed.',
        transferId: t.transfer_id,
        status: t.status,
        sourceAccount: t.sender_account,
        destinationAccount: t.receiver_account,
        amount: t.amount,
        timestamp: t.created_at.toISOString(),
        errorMessage: t.error_message,
      });
    }

    const response: Record<string, unknown> = {
      transferId: t.transfer_id,
      status: t.status,
      sourceAccount: t.sender_account,
      destinationAccount: t.receiver_account,
      amount: t.amount,
      timestamp: t.created_at.toISOString(),
    };

    if (t.exchange_rate) {
      response.exchangeRate = parseFloat(t.exchange_rate).toFixed(6);
      response.convertedAmount = parseFloat(t.converted_amount).toFixed(2);
    }

    if (t.rate_captured_at) {
      response.rateCapturedAt = t.rate_captured_at.toISOString();
    }

    if (t.status === 'pending') {
      response.pendingSince = t.created_at.toISOString();
      if (t.next_retry_at) response.nextRetryAt = t.next_retry_at.toISOString();
      response.retryCount = t.retry_count;
    }

    if (t.error_message) {
      response.errorMessage = t.error_message;
    }

    res.json(response);
  } catch (err) {
    console.error('Error fetching transfer:', err);
    res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Failed to fetch transfer' });
  }
});

// Start server and retry worker
let server = app.listen(PORT, () => {
  console.log(`transfer-service listening on port ${PORT}`);
  startRetryWorker(pool, retryQueue);
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
