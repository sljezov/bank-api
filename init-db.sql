-- Users schema
CREATE SCHEMA IF NOT EXISTS users;

CREATE TABLE IF NOT EXISTS users.users (
  id          TEXT PRIMARY KEY,
  full_name   TEXT NOT NULL,
  email       TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_idx ON users.users(email) WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS users.api_keys (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     TEXT NOT NULL REFERENCES users.users(id),
  token_hash  TEXT NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Accounts schema
CREATE SCHEMA IF NOT EXISTS accounts;

CREATE TABLE IF NOT EXISTS accounts.accounts (
  account_number  TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  currency        TEXT NOT NULL,
  balance         NUMERIC(18,2) NOT NULL DEFAULT 0.00,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS accounts_user_id_idx ON accounts.accounts(user_id);

-- Transfers schema
CREATE SCHEMA IF NOT EXISTS transfers;

CREATE TABLE IF NOT EXISTS transfers.transfers (
  transfer_id          UUID PRIMARY KEY,
  sender_account       TEXT NOT NULL,
  receiver_account     TEXT NOT NULL,
  amount               NUMERIC(18,2) NOT NULL,
  currency             TEXT NOT NULL,
  status               TEXT NOT NULL,
  is_cross_bank        BOOLEAN NOT NULL DEFAULT FALSE,
  destination_bank_id  TEXT,
  exchange_rate        NUMERIC(18,6),
  converted_amount     NUMERIC(18,2),
  rate_captured_at     TIMESTAMPTZ,
  retry_count          INT NOT NULL DEFAULT 0,
  next_retry_at        TIMESTAMPTZ,
  expires_at           TIMESTAMPTZ,
  error_message        TEXT,
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS transfers_status_idx ON transfers.transfers(status);
CREATE INDEX IF NOT EXISTS transfers_next_retry_idx ON transfers.transfers(next_retry_at) WHERE status = 'pending';

-- Bank sync schema
CREATE SCHEMA IF NOT EXISTS bank_sync;

CREATE TABLE IF NOT EXISTS bank_sync.bank_registration (
  bank_id       TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  address       TEXT NOT NULL,
  private_key   TEXT NOT NULL,
  public_key    TEXT NOT NULL,
  registered_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bank_sync.bank_directory (
  bank_id         TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  address         TEXT NOT NULL,
  public_key      TEXT NOT NULL,
  last_heartbeat  TIMESTAMPTZ,
  synced_at       TIMESTAMPTZ DEFAULT NOW()
);
