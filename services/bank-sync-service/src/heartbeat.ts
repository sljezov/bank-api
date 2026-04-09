import { Pool } from 'pg';
import cron from 'node-cron';
import { registerWithCentralBank, BankRegistration } from './registration';

const CENTRAL_BANK_URL = process.env.CENTRAL_BANK_URL || 'https://test.diarainfra.com/central-bank';

export function startHeartbeat(pool: Pool, registration: { current: BankRegistration }): void {
  // Run every 15 minutes
  cron.schedule('*/15 * * * *', async () => {
    await sendHeartbeat(pool, registration);
  });

  // Also send initial heartbeat after 1 minute
  setTimeout(() => sendHeartbeat(pool, registration), 60 * 1000);
}

async function sendHeartbeat(pool: Pool, registration: { current: BankRegistration }): Promise<void> {
  const { bankId } = registration.current;
  console.log(`Sending heartbeat for bank ${bankId}...`);

  try {
    const response = await fetch(
      `${CENTRAL_BANK_URL}/api/v1/banks/${bankId}/heartbeat`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timestamp: new Date().toISOString() }),
      }
    );

    if (response.status === 410) {
      console.log('Bank registration expired (410 Gone). Re-registering...');
      // Clear old registration
      await pool.query('DELETE FROM bank_sync.bank_registration WHERE bank_id = $1', [bankId]);
      const newReg = await registerWithCentralBank(pool);
      registration.current = newReg;
      console.log(`Re-registered as: ${newReg.bankId}`);
      return;
    }

    if (!response.ok) {
      console.error(`Heartbeat failed: ${response.status}`);
      return;
    }

    const data = await response.json() as { expiresAt: string };
    console.log(`Heartbeat sent. Expires at: ${data.expiresAt}`);
  } catch (err) {
    console.error('Heartbeat error:', err);
  }
}
