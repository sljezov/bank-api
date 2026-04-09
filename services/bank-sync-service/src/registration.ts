import { Pool } from 'pg';
import { generateKeyPair, exportSPKI, exportPKCS8 } from 'jose';

const CENTRAL_BANK_URL = process.env.CENTRAL_BANK_URL || 'https://test.diarainfra.com/central-bank';

export const SUPPORTED_CURRENCIES = ['EUR', 'USD', 'GBP', 'SEK', 'LVL', 'EEK'];

export function isCurrencySupported(currency: string): boolean {
  return SUPPORTED_CURRENCIES.includes(currency.toUpperCase());
}

export interface BankRegistration {
  bankId: string;
  privateKey: string;
  publicKey: string;
  name: string;
  address: string;
}

export async function ensureRegistered(pool: Pool): Promise<BankRegistration> {
  // Check if already registered
  const existing = await pool.query(
    'SELECT bank_id, name, address, private_key, public_key FROM bank_sync.bank_registration LIMIT 1'
  );

  if (existing.rows.length > 0) {
    const row = existing.rows[0];
    console.log(`Already registered as bank: ${row.bank_id}`);
    return {
      bankId: row.bank_id,
      privateKey: row.private_key,
      publicKey: row.public_key,
      name: row.name,
      address: row.address,
    };
  }

  return await registerWithCentralBank(pool);
}

export async function registerWithCentralBank(pool: Pool): Promise<BankRegistration> {
  const bankName = process.env.BANK_NAME || 'Test Branch Bank';
  const bankAddress = process.env.BANK_PUBLIC_URL || 'http://localhost:3000/api/v1';

  console.log('Generating EC key pair...');
  const { privateKey, publicKey } = await generateKeyPair('ES256');

  const privateKeyPem = await exportPKCS8(privateKey);
  const publicKeyPem = await exportSPKI(publicKey);

  console.log(`Registering with central bank at ${CENTRAL_BANK_URL}...`);

  const response = await fetch(`${CENTRAL_BANK_URL}/api/v1/banks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: bankName,
      address: bankAddress,
      publicKey: publicKeyPem,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to register with central bank: ${response.status} ${error}`);
  }

  const data = await response.json() as { bankId: string; expiresAt: string };
  const { bankId } = data;

  console.log(`Registered with central bank. bankId: ${bankId}`);

  // Store registration
  await pool.query(
    `INSERT INTO bank_sync.bank_registration (bank_id, name, address, private_key, public_key)
     VALUES ($1, $2, $3, $4, $5)`,
    [bankId, bankName, bankAddress, privateKeyPem, publicKeyPem]
  );

  return {
    bankId,
    privateKey: privateKeyPem,
    publicKey: publicKeyPem,
    name: bankName,
    address: bankAddress,
  };
}
