import { Pool } from 'pg';
import { importSPKI, jwtVerify } from 'jose';

const BANK_SYNC_SERVICE_URL = process.env.BANK_SYNC_SERVICE_URL || 'http://bank-sync-service:3004';

export interface CrossBankTransferData {
  transfer_id: string;
  sender_account: string;
  receiver_account: string;
  amount: string;
  currency: string;
  destination_bank_id: string;
  exchange_rate: string | null;
  converted_amount: string | null;
}

export class DestinationBankUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DestinationBankUnavailableError';
  }
}

export async function sendCrossBankTransfer(
  _pool: Pool,
  transfer: CrossBankTransferData
): Promise<void> {
  // Get destination bank info
  const bankRes = await fetch(
    `${BANK_SYNC_SERVICE_URL}/internal/banks/${transfer.destination_bank_id}`
  );

  if (!bankRes.ok) {
    throw new Error(`Destination bank ${transfer.destination_bank_id} not found`);
  }

  const bank = await bankRes.json() as { address: string };

  // Sign JWT via bank-sync-service
  const payload = {
    transferId: transfer.transfer_id,
    sourceAccount: transfer.sender_account,
    destinationAccount: transfer.receiver_account,
    amount: transfer.converted_amount || transfer.amount,
    sourceBankId: await getOurBankId(),
    destinationBankId: transfer.destination_bank_id,
    timestamp: new Date().toISOString(),
  };

  const signRes = await fetch(`${BANK_SYNC_SERVICE_URL}/internal/sign-jwt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ payload }),
  });

  if (!signRes.ok) {
    throw new Error('Failed to sign inter-bank JWT');
  }

  const { jwt } = await signRes.json() as { jwt: string };

  // Send to destination bank
  const destUrl = bank.address.replace(/\/+$/, '');
  const transferRes = await fetch(`${destUrl}/api/v1/transfers/receive`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jwt }),
  });

  if (!transferRes.ok) {
    const errBody = await transferRes.text();
    // 5xx = bank unavailable, retry
    if (transferRes.status >= 500) {
      throw new DestinationBankUnavailableError(`Destination bank unavailable: ${transferRes.status}`);
    }
    // 404 on the receive endpoint itself = routing issue, not account not found — retry
    if (transferRes.status === 404 && !errBody.includes('ACCOUNT_NOT_FOUND')) {
      throw new DestinationBankUnavailableError(`Destination bank receive endpoint not reachable: ${errBody}`);
    }
    throw new Error(`Destination bank rejected transfer: ${transferRes.status} ${errBody}`);
  }
}

let cachedBankId: string | null = null;

async function getOurBankId(): Promise<string> {
  if (cachedBankId) return cachedBankId;

  const res = await fetch(`${BANK_SYNC_SERVICE_URL}/internal/bank-info`);
  if (!res.ok) throw new Error('Failed to get our bank ID');
  const data = await res.json() as { bankId: string };
  cachedBankId = data.bankId;
  return cachedBankId;
}

async function verifyWithKey(jwt: string, publicKeyPem: string): Promise<Record<string, unknown>> {
  const publicKey = await importSPKI(publicKeyPem, 'ES256');
  const { payload } = await jwtVerify(jwt, publicKey, { algorithms: ['ES256'] });
  return payload as Record<string, unknown>;
}

export async function verifyIncomingJWT(
  jwt: string
): Promise<{
  transferId: string;
  sourceAccount: string;
  destinationAccount: string;
  amount: string;
  sourceBankId: string;
  destinationBankId: string;
  timestamp: string;
}> {
  // Decode payload to get sourceBankId (without verifying yet)
  const parts = jwt.split('.');
  if (parts.length !== 3) throw new Error('Invalid JWT format');

  const payloadStr = Buffer.from(parts[1], 'base64url').toString('utf8');
  const payload = JSON.parse(payloadStr);

  const sourceBankId = payload.sourceBankId;
  if (!sourceBankId) throw new Error('JWT missing sourceBankId');

  // Fetch source bank's public key from cache
  const bankRes = await fetch(`${BANK_SYNC_SERVICE_URL}/internal/banks/${sourceBankId}`);
  if (!bankRes.ok) throw new Error(`Source bank ${sourceBankId} not found in directory`);
  const bank = await bankRes.json() as { publicKey: string };

  try {
    const verified = await verifyWithKey(jwt, bank.publicKey);
    return verified as unknown as {
      transferId: string;
      sourceAccount: string;
      destinationAccount: string;
      amount: string;
      sourceBankId: string;
      destinationBankId: string;
      timestamp: string;
    };
  } catch (err) {
    // Signature verification failed — key may have changed. Retry with fresh key from central bank.
    console.warn(`JWT verification failed for bank ${sourceBankId}, retrying with fresh key...`);
    const freshRes = await fetch(`${BANK_SYNC_SERVICE_URL}/internal/banks/${sourceBankId}?fresh=true`);
    if (!freshRes.ok) throw new Error(`Source bank ${sourceBankId} not found in directory`);
    const freshBank = await freshRes.json() as { publicKey: string };

    // If same key, throw original error — key didn't change, JWT is genuinely invalid
    if (freshBank.publicKey === bank.publicKey) throw err;

    const verified = await verifyWithKey(jwt, freshBank.publicKey);
    return verified as unknown as {
      transferId: string;
      sourceAccount: string;
      destinationAccount: string;
      amount: string;
      sourceBankId: string;
      destinationBankId: string;
      timestamp: string;
    };
  }
}
