import { Worker, Queue } from 'bullmq';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { sendCrossBankTransfer } from './cross-bank';

const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379';
const ACCOUNT_SERVICE_URL = process.env.ACCOUNT_SERVICE_URL || 'http://account-service:3002';

const redis = new Redis(REDIS_URL);

// Exponential backoff delays in milliseconds
const RETRY_DELAYS_MS = [
  1 * 60 * 1000,   // 1 minute
  2 * 60 * 1000,   // 2 minutes
  4 * 60 * 1000,   // 4 minutes
  8 * 60 * 1000,   // 8 minutes
  16 * 60 * 1000,  // 16 minutes
  32 * 60 * 1000,  // 32 minutes
  60 * 60 * 1000,  // 60 minutes (cap)
];

function getRetryDelay(retryCount: number): number {
  return RETRY_DELAYS_MS[Math.min(retryCount, RETRY_DELAYS_MS.length - 1)];
}

export function createRetryQueue(connection: { host: string; port: number }): Queue {
  return new Queue('transfer-retry', { connection });
}

async function acquireLock(transferId: string): Promise<boolean> {
  const lockKey = `transfer:lock:${transferId}`;
  const result = await redis.set(lockKey, '1', 'EX', 300, 'NX');
  return result === 'OK';
}

async function releaseLock(transferId: string): Promise<void> {
  const lockKey = `transfer:lock:${transferId}`;
  await redis.del(lockKey);
}

export function startRetryWorker(pool: Pool, queue: Queue): void {
  const parsedUrl = new URL(REDIS_URL.startsWith('redis://') ? REDIS_URL : `redis://${REDIS_URL}`);
  const connection = { host: parsedUrl.hostname, port: parseInt(parsedUrl.port || '6379', 10) };

  const worker = new Worker(
    'transfer-retry',
    async (job) => {
      const { transferId } = job.data;
      console.log(`Processing retry for transfer ${transferId}`);

      // Acquire idempotency lock
      const lockAcquired = await acquireLock(transferId);
      if (!lockAcquired) {
        console.log(`Transfer ${transferId} already being processed, skipping`);
        return;
      }

      try {
        // Fetch transfer from DB
        const result = await pool.query(
          `SELECT * FROM transfers.transfers WHERE transfer_id = $1 FOR UPDATE`,
          [transferId]
        );

        if (result.rows.length === 0) {
          console.error(`Transfer ${transferId} not found`);
          return;
        }

        const transfer = result.rows[0];

        // Check if expired (4 hours)
        if (transfer.expires_at && new Date() > new Date(transfer.expires_at)) {
          console.log(`Transfer ${transferId} has expired. Refunding...`);
          await handleTransferTimeout(pool, transfer);
          return;
        }

        if (transfer.status !== 'pending') {
          console.log(`Transfer ${transferId} is no longer pending (status: ${transfer.status}). Skipping.`);
          return;
        }

        // Attempt the transfer again
        try {
          await sendCrossBankTransfer(pool, transfer);
          // Success - mark as completed
          await pool.query(
            `UPDATE transfers.transfers
             SET status = 'completed', updated_at = NOW()
             WHERE transfer_id = $1 AND status = 'pending'`,
            [transferId]
          );
          console.log(`Transfer ${transferId} completed on retry`);
        } catch (err) {
          console.error(`Retry failed for transfer ${transferId}:`, err);

          const newRetryCount = transfer.retry_count + 1;
          const delay = getRetryDelay(newRetryCount);
          const nextRetryAt = new Date(Date.now() + delay);

          await pool.query(
            `UPDATE transfers.transfers
             SET retry_count = $1, next_retry_at = $2, updated_at = NOW()
             WHERE transfer_id = $3`,
            [newRetryCount, nextRetryAt, transferId]
          );

          // Check if still within 4-hour window
          if (transfer.expires_at && new Date(Date.now() + delay) < new Date(transfer.expires_at)) {
            await queue.add('retry', { transferId }, { delay });
            console.log(`Transfer ${transferId} queued for retry in ${delay}ms (attempt ${newRetryCount})`);
          } else {
            // Would expire before next retry
            await handleTransferTimeout(pool, transfer);
          }
        }
      } finally {
        // Always release lock
        await releaseLock(transferId);
      }
    },
    { connection }
  );

  worker.on('completed', (job) => {
    console.log(`Job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    console.error(`Job ${job?.id} failed:`, err);
  });

  // Periodic cleanup: check for expired pending transfers
  setInterval(async () => {
    try {
      const expired = await pool.query(
        `SELECT * FROM transfers.transfers
         WHERE status = 'pending' AND expires_at < NOW()`,
      );

      for (const transfer of expired.rows) {
        console.log(`Found expired transfer: ${transfer.transfer_id}`);
        await handleTransferTimeout(pool, transfer);
      }
    } catch (err) {
      console.error('Error checking expired transfers:', err);
    }
  }, 60 * 1000); // Check every minute
}

async function handleTransferTimeout(pool: Pool, transfer: Record<string, unknown>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Update status to failed_timeout
    await client.query(
      `UPDATE transfers.transfers
       SET status = 'failed_timeout', updated_at = NOW(),
           error_message = 'Transfer timed out after 4 hours. Funds refunded to source account.'
       WHERE transfer_id = $1 AND status = 'pending'`,
      [transfer.transfer_id]
    );

    // Refund sender
    const refundRes = await fetch(
      `${ACCOUNT_SERVICE_URL}/internal/accounts/${transfer.sender_account}/credit`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: transfer.amount }),
      }
    );

    if (!refundRes.ok) {
      throw new Error(`Refund failed for transfer ${transfer.transfer_id}`);
    }

    await client.query('COMMIT');
    console.log(`Transfer ${transfer.transfer_id} timed out. Funds refunded.`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`Failed to handle timeout for ${transfer.transfer_id}:`, err);
  } finally {
    client.release();
  }
}
