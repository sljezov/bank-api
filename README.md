# EST001 Branch Bank API

A fully functional bank branch API built with a microservices architecture. Registered with the Central Bank as **EST001**, serving account numbers with the `EST` prefix.

**Live API:** `http://89.167.117.189:3000/api/v1`  
**Swagger UI:** `http://89.167.117.189:3000/api-docs`  
**OpenAPI spec:** `http://89.167.117.189:3000/api-docs.json`

---

## Technologies

| Layer | Technology |
|---|---|
| Language | TypeScript (Node.js 20) |
| Framework | Express.js |
| Database | PostgreSQL 16 |
| Cache / Queue broker | Redis 7 |
| Job queue | BullMQ (transfer retry) |
| JWT signing | jose (ES256 / ECDSA P-256) |
| Container orchestration | Docker Compose |
| Load balancing | Nginx (stream mode, TCP) |

---

## Microservices Architecture

```
Internet
    │
    ▼
┌─────────────────────────────────────┐
│          Nginx (port 3000)          │  ← HTTP load balancer
│         api-gateway-lb              │
└─────────────────────────────────────┘
        │           │           │
        ▼           ▼           ▼
┌──────────┐ ┌──────────┐ ┌──────────┐
│api-gw-1  │ │api-gw-2  │ │api-gw-3  │  ← Rate limiting, auth, routing
└──────────┘ └──────────┘ └──────────┘
     │               │
     ▼               ▼
┌──────────────┐  ┌──────────────────────┐
│ user-service │  │   account-service    │
│  (×3, lb)    │  │      (×2, lb)        │
└──────────────┘  └──────────────────────┘
                       │
                  ┌──────────────────────┐
                  │  transfer-service    │
                  │     (×2, lb)         │
                  └──────────────────────┘
                       │           │
                       ▼           ▼
                  ┌────────┐  ┌─────────────────┐
                  │  Redis │  │ bank-sync-service│
                  │(BullMQ)│  │ (registration,  │
                  └────────┘  │  heartbeat,     │
                              │  bank directory)│
                              └─────────────────┘
                                     │
                              ┌──────────────┐
                              │  PostgreSQL   │
                              └──────────────┘
```

### Services

| Service | Port | Responsibility |
|---|---|---|
| `api-gateway` (×3) | 3000 | Auth, rate limiting (100 req/min/IP), request routing |
| `user-service` (×3) | 3001 | User registration, token issuance |
| `account-service` (×2) | 3002 | Account creation, balance management, atomic transfers |
| `transfer-service` (×2) | 3003 | Transfer orchestration, cross-bank retry queue, idempotency |
| `bank-sync-service` (×1) | 3004 | Central bank registration, heartbeat (15 min), bank directory sync, JWT signing |
| `postgres` | 5432 | Primary datastore |
| `redis` | 6379 | BullMQ job queue, bank directory cache, exchange rate cache |

---

## Database Schema

```
Schema: users
├── users (id, full_name, email, created_at)
└── api_keys (id, user_id, token_hash, expires_at, created_at)

Schema: accounts
└── accounts (account_number PK, user_id, currency, balance NUMERIC, created_at)

Schema: transfers
└── transfers (
      transfer_id UUID PK,
      sender_account, receiver_account,
      amount NUMERIC, currency,
      converted_amount NUMERIC, exchange_rate NUMERIC(20,6),
      status [completed|pending|failed|failed_timeout],
      is_cross_bank BOOL,
      destination_bank_id,
      retry_count INT, next_retry_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ,        -- 4h timeout window
      error_message TEXT,
      created_at, updated_at
    )

Schema: bank_sync
├── bank_registration (bank_id, name, address, public_key, private_key, created_at)
└── bank_directory (bank_id, name, address, public_key, last_heartbeat, synced_at)
```

**Key design decisions:**
- All monetary amounts stored as `NUMERIC` (no floating point)
- Integer cent arithmetic in application layer (`toCents`/`fromCents`)
- Same-bank transfers use a single DB transaction locking both accounts (deadlock prevention via consistent lock order)
- Cross-bank transfers use a BullMQ queue with exponential backoff: 1→2→4→8→16→32→60 min
- Automatic refund to source account after 4-hour timeout

---

## Installation & Running

### Prerequisites
- Docker & Docker Compose
- SSH access to a Linux server

### Local

```bash
git clone <repo-url>
cd bank
docker compose up --build
```

API available at `http://localhost:3000/api/v1`

### Production deployment

```bash
# Sync code to server
rsync -az --delete . user@server:~/bank/ --exclude node_modules --exclude .git

# SSH to server and start
ssh user@server
cd ~/bank
docker compose up -d --build
```

---

## API Endpoints

Base URL: `http://89.167.117.189:3000/api/v1`

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/health` | None | Health check |
| POST | `/users` | None | Register new user |
| GET | `/users/{userId}` | Bearer | Get user info |
| POST | `/users/{userId}/accounts` | Bearer | Create account |
| GET | `/accounts/{accountNumber}` | None | Public account lookup |
| POST | `/transfers` | Bearer | Initiate transfer |
| GET | `/transfers/{transferId}` | Bearer | Get transfer status |
| POST | `/transfers/receive` | Bank JWT | Receive inter-bank transfer |
| GET | `/api-docs.json` | None | OpenAPI specification |

---

## Example Requests

### Register a user
```bash
curl -X POST http://89.167.117.189:3000/api/v1/users \
  -H "Content-Type: application/json" \
  -d '{"fullName": "Jane Doe", "email": "jane@example.com"}'
```

**Response (201):**
```json
{
  "userId": "user-550e8400-...",
  "fullName": "Jane Doe",
  "email": "jane@example.com",
  "createdAt": "2026-04-09T12:00:00Z",
  "token": "your-bearer-token-here"
}
```

### Create an account
```bash
curl -X POST http://89.167.117.189:3000/api/v1/users/{userId}/accounts \
  -H "Authorization: Bearer your-token" \
  -H "Content-Type: application/json" \
  -d '{"currency": "EUR"}'
```

**Response (201):**
```json
{
  "accountNumber": "EST12345",
  "ownerId": "user-550e8400-...",
  "currency": "EUR",
  "balance": "0.00",
  "createdAt": "2026-04-09T12:00:00Z"
}
```

### Initiate a transfer
```bash
curl -X POST http://89.167.117.189:3000/api/v1/transfers \
  -H "Authorization: Bearer your-token" \
  -H "Content-Type: application/json" \
  -d '{
    "transferId": "550e8400-e29b-41d4-a716-446655440000",
    "sourceAccount": "EST12345",
    "destinationAccount": "LAT54321",
    "amount": "100.00",
    "currency": "EUR"
  }'
```

**Response — same-bank (201):**
```json
{
  "transferId": "550e8400-...",
  "status": "completed",
  "sourceAccount": "EST12345",
  "destinationAccount": "EST54321",
  "amount": "100.00",
  "timestamp": "2026-04-09T12:00:05Z"
}
```

**Response — cross-bank with conversion (201):**
```json
{
  "transferId": "550e8400-...",
  "status": "completed",
  "sourceAccount": "EST12345",
  "destinationAccount": "LAT54321",
  "amount": "100.00",
  "convertedAmount": "85.00",
  "exchangeRate": "0.850000",
  "timestamp": "2026-04-09T12:00:05Z"
}
```

---

## Test Results

All endpoints tested against the OpenAPI spec:

| Endpoint | Test | Expected | Result |
|---|---|---|---|
| GET /health | Normal | 200 `{status,timestamp}` | PASS |
| POST /users | New user | 201 + token | PASS |
| POST /users | Duplicate email | 409 | PASS |
| GET /users/:id | Authenticated | 200 | PASS |
| GET /users/:id | No token | 401 | PASS |
| POST /users/:id/accounts | EUR account | 201 EST-prefix | PASS |
| POST /users/:id/accounts | Unsupported currency | 400 | PASS |
| POST /users/:id/accounts | Wrong user | 403 | PASS |
| GET /accounts/:num | Valid | 200 | PASS |
| GET /accounts/:num | Invalid format | 400 | PASS |
| GET /accounts/:num | Not found | 404 | PASS |
| POST /transfers | Same-bank | 201 completed | PASS |
| POST /transfers | Insufficient funds | 422 | PASS |
| POST /transfers | Duplicate transferId | 409 | PASS |
| GET /transfers/:id | Get status | 200 | PASS |
| GET /transfers/:id | Not found | 404 | PASS |
| POST /transfers/receive | Invalid JWT | 401 | PASS |
| Rate limiting | >100 req/min | 429 | PASS |

### Central Bank Integration
- Registered as **EST001** at `http://89.167.117.189:3000`
- Heartbeat sent every 15 minutes (timeout threshold: 30 min)
- Bank directory synced every 5 minutes
- Exchange rates cached 10 min (24h fallback)

### Inter-bank Transfer Test
Successfully sent 100 EUR to AKB001 bank account `AKB5FPC8`.

---

## Supported Currencies

`EUR`, `USD`, `GBP`, `SEK`, `LVL`, `EEK`

Currency conversion uses live rates from the Central Bank (EUR base). Rates are cached for 10 minutes with a 24-hour stale fallback.
