#!/usr/bin/env bash
# Automated API compliance tests for EST001 Branch Bank
# Usage: ./test/api.test.sh [BASE_URL]
# Example: ./test/api.test.sh http://localhost:3000/api/v1

BASE="${1:-http://89.167.117.189:3000/api/v1}"
DOCS="${BASE%/api/v1}"  # strip /api/v1 for top-level paths

PASS=0; FAIL=0; TOTAL=0

# ── helpers ────────────────────────────────────────────────────────────────────

check() {
  local desc="$1" expected="$2" actual="$3"
  TOTAL=$((TOTAL+1))
  if [ "$actual" = "$expected" ]; then
    printf "\033[32mPASS\033[0m [%s] %s\n" "$actual" "$desc"
    PASS=$((PASS+1))
  else
    printf "\033[31mFAIL\033[0m [%s != %s] %s\n" "$actual" "$expected" "$desc"
    FAIL=$((FAIL+1))
  fi
}

check_field() {
  local desc="$1" val="$2"
  TOTAL=$((TOTAL+1))
  if [ -n "$val" ] && [ "$val" != "null" ]; then
    printf "\033[32mPASS\033[0m [field] %s\n" "$desc"
    PASS=$((PASS+1))
  else
    printf "\033[31mFAIL\033[0m [field] %s (got: '%s')\n" "$desc" "$val"
    FAIL=$((FAIL+1))
  fi
}

# HTTP status + body (body on first line, status on last)
req() { curl -s -w "\n%{http_code}" "$@"; }
status() { echo "$1" | tail -1; }
body()   { echo "$1" | head -1; }
jq_val() { echo "$1" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('$2',''))" 2>/dev/null; }
new_uuid() { python3 -c "import uuid; print(uuid.uuid4())"; }

echo "=============================================="
echo " EST001 Branch Bank API — Automated Tests"
echo " Target: $BASE"
echo "=============================================="
echo ""

# ══════════════════════════════════════════════════════════════════════════════
# 1. HEALTH
# ══════════════════════════════════════════════════════════════════════════════
echo "── 1. Health ──────────────────────────────────"
R=$(req "$DOCS/health")
S=$(status "$R"); B=$(body "$R")
check "GET /health → 200"   200 "$S"
check_field "GET /health has 'status'" "$(jq_val "$B" status)"
check_field "GET /health has 'timestamp'" "$(jq_val "$B" timestamp)"

echo ""

# ══════════════════════════════════════════════════════════════════════════════
# 2. USER REGISTRATION
# ══════════════════════════════════════════════════════════════════════════════
echo "── 2. User Registration ────────────────────────"
UNIQUE="$(new_uuid | cut -c1-8)"
EMAIL="test_${UNIQUE}@autotest.com"

R=$(req -X POST "$BASE/users" -H "Content-Type: application/json" \
    -d "{\"fullName\":\"Auto Tester\",\"email\":\"$EMAIL\"}")
S=$(status "$R"); B=$(body "$R")
check "POST /users → 201"         201 "$S"
TOKEN=$(jq_val "$B" token)
USERID=$(jq_val "$B" userId)
check_field "POST /users returns token"  "$TOKEN"
check_field "POST /users returns userId" "$USERID"

# Duplicate email
R=$(req -X POST "$BASE/users" -H "Content-Type: application/json" \
    -d "{\"fullName\":\"Auto Tester\",\"email\":\"$EMAIL\"}")
check "POST /users duplicate email → 409" 409 "$(status "$R")"

# Missing fullName
R=$(req -X POST "$BASE/users" -H "Content-Type: application/json" -d '{}')
check "POST /users missing fullName → 400" 400 "$(status "$R")"

# fullName too short (<2 chars)
R=$(req -X POST "$BASE/users" -H "Content-Type: application/json" -d '{"fullName":"A"}')
check "POST /users fullName too short → 400" 400 "$(status "$R")"

echo ""

# ══════════════════════════════════════════════════════════════════════════════
# 3. GET USER
# ══════════════════════════════════════════════════════════════════════════════
echo "── 3. Get User ─────────────────────────────────"
R=$(req "$BASE/users/$USERID" -H "Authorization: Bearer $TOKEN")
check "GET /users/:userId → 200"               200 "$(status "$R")"

R=$(req "$BASE/users/$USERID")
check "GET /users/:userId no auth → 401"       401 "$(status "$R")"

R=$(req "$BASE/users/user-00000000-0000-0000-0000-000000000000" -H "Authorization: Bearer $TOKEN")
check "GET /users/nonexistent → 404"           404 "$(status "$R")"

echo ""

# ══════════════════════════════════════════════════════════════════════════════
# 4. ACCOUNT CREATION
# ══════════════════════════════════════════════════════════════════════════════
echo "── 4. Account Creation ─────────────────────────"
R=$(req -X POST "$BASE/users/$USERID/accounts" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d '{"currency":"EUR"}')
S=$(status "$R"); B=$(body "$R")
check "POST /accounts EUR → 201"               201 "$S"
SRC=$(jq_val "$B" accountNumber)
check_field "accountNumber present"            "$SRC"

# Check format: exactly 8 uppercase alphanumeric
if echo "$SRC" | grep -qE '^[A-Z0-9]{8}$'; then
  check_field "accountNumber 8-char alphanumeric ($SRC)" "$SRC"
else
  check_field "accountNumber format wrong ($SRC)" ""
fi

# Check prefix
PREFIX="${SRC:0:3}"
check "accountNumber has EST prefix" "EST" "$PREFIX"

# Unsupported currency
R=$(req -X POST "$BASE/users/$USERID/accounts" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d '{"currency":"JPY"}')
check "POST /accounts unsupported currency → 400" 400 "$(status "$R")"

# Invalid currency format
R=$(req -X POST "$BASE/users/$USERID/accounts" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d '{"currency":"eu"}')
check "POST /accounts invalid format → 400"    400 "$(status "$R")"

# No auth
R=$(req -X POST "$BASE/users/$USERID/accounts" \
    -H "Content-Type: application/json" -d '{"currency":"EUR"}')
check "POST /accounts no auth → 401"           401 "$(status "$R")"

# Wrong user (create second user)
R2=$(req -X POST "$BASE/users" -H "Content-Type: application/json" \
     -d "{\"fullName\":\"Other User\"}")
TOKEN2=$(jq_val "$(body "$R2")" token)
USERID2=$(jq_val "$(body "$R2")" userId)
R2=$(req -X POST "$BASE/users/$USERID2/accounts" \
     -H "Authorization: Bearer $TOKEN2" -H "Content-Type: application/json" \
     -d '{"currency":"EUR"}')
DST=$(jq_val "$(body "$R2")" accountNumber)

# Try to create account for USERID using TOKEN2
R=$(req -X POST "$BASE/users/$USERID/accounts" \
    -H "Authorization: Bearer $TOKEN2" -H "Content-Type: application/json" \
    -d '{"currency":"EUR"}')
check "POST /accounts wrong user → 403"        403 "$(status "$R")"

echo ""

# ══════════════════════════════════════════════════════════════════════════════
# 5. ACCOUNT LOOKUP
# ══════════════════════════════════════════════════════════════════════════════
echo "── 5. Account Lookup ───────────────────────────"
R=$(req "$BASE/accounts/$SRC")
S=$(status "$R"); B=$(body "$R")
check "GET /accounts/:num → 200 (no auth)"     200 "$S"
check_field "GET /accounts returns ownerName"  "$(jq_val "$B" ownerName)"
check_field "GET /accounts returns currency"   "$(jq_val "$B" currency)"

# Invalid format (lowercase / short)
R=$(req "$BASE/accounts/bad")
check "GET /accounts/bad → 400"                400 "$(status "$R")"

# Too long
R=$(req "$BASE/accounts/TOOLONGNUM")
check "GET /accounts/TOOLONGNUM → 400"         400 "$(status "$R")"

# Not found
R=$(req "$BASE/accounts/ZZZZZZZZ")
check "GET /accounts/ZZZZZZZZ → 404"           404 "$(status "$R")"

echo ""

# ══════════════════════════════════════════════════════════════════════════════
# 6. TRANSFERS
# ══════════════════════════════════════════════════════════════════════════════
echo "── 6. Transfers ────────────────────────────────"

# Fund the source account (internal)
curl -s -X POST "http://89.167.117.189:3002/internal/accounts/$SRC/credit" \
  -H "Content-Type: application/json" -d '{"amount":"100.00"}' -o /dev/null 2>/dev/null || \
ssh -o BatchMode=yes saskia@89.167.117.189 \
  "sudo docker exec bank-account-service-1-1 wget -q -O- \
   --post-data='{\"amount\":\"100.00\"}' \
   --header='Content-Type: application/json' \
   http://localhost:3002/internal/accounts/$SRC/credit" > /dev/null 2>/dev/null

TXID1=$(new_uuid)
R=$(req -X POST "$BASE/transfers" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d "{\"transferId\":\"$TXID1\",\"sourceAccount\":\"$SRC\",\"destinationAccount\":\"$DST\",\"amount\":\"10.00\",\"currency\":\"EUR\"}")
S=$(status "$R"); B=$(body "$R")
check "POST /transfers same-bank → 201"        201 "$S"
TX_STATUS=$(jq_val "$B" status)
check "POST /transfers status=completed"       "completed" "$TX_STATUS"
INTERNAL_ID=$(jq_val "$B" transferId)
check_field "POST /transfers returns transferId" "$INTERNAL_ID"

# Duplicate transferId → 409
R=$(req -X POST "$BASE/transfers" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d "{\"transferId\":\"$TXID1\",\"sourceAccount\":\"$SRC\",\"destinationAccount\":\"$DST\",\"amount\":\"1.00\",\"currency\":\"EUR\"}")
check "POST /transfers duplicate → 409"        409 "$(status "$R")"

# Insufficient funds → 422
TXID2=$(new_uuid)
R=$(req -X POST "$BASE/transfers" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d "{\"transferId\":\"$TXID2\",\"sourceAccount\":\"$SRC\",\"destinationAccount\":\"$DST\",\"amount\":\"99999.00\",\"currency\":\"EUR\"}")
check "POST /transfers insufficient funds → 422" 422 "$(status "$R")"

# Missing transferId → 400
R=$(req -X POST "$BASE/transfers" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d "{\"sourceAccount\":\"$SRC\",\"destinationAccount\":\"$DST\",\"amount\":\"1.00\",\"currency\":\"EUR\"}")
check "POST /transfers missing transferId → 400" 400 "$(status "$R")"

# Non-UUID transferId → 400
R=$(req -X POST "$BASE/transfers" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d "{\"transferId\":\"not-a-uuid\",\"sourceAccount\":\"$SRC\",\"destinationAccount\":\"$DST\",\"amount\":\"1.00\",\"currency\":\"EUR\"}")
check "POST /transfers non-UUID transferId → 400" 400 "$(status "$R")"

# No auth → 401
R=$(req -X POST "$BASE/transfers" \
    -H "Content-Type: application/json" \
    -d "{\"transferId\":\"$(new_uuid)\",\"sourceAccount\":\"$SRC\",\"destinationAccount\":\"$DST\",\"amount\":\"1.00\",\"currency\":\"EUR\"}")
check "POST /transfers no auth → 401"          401 "$(status "$R")"

# Wrong owner → 403
R=$(req -X POST "$BASE/transfers" \
    -H "Authorization: Bearer $TOKEN2" -H "Content-Type: application/json" \
    -d "{\"transferId\":\"$(new_uuid)\",\"sourceAccount\":\"$SRC\",\"destinationAccount\":\"$DST\",\"amount\":\"1.00\",\"currency\":\"EUR\"}")
check "POST /transfers wrong owner → 403"      403 "$(status "$R")"

echo ""

# ══════════════════════════════════════════════════════════════════════════════
# 7. TRANSFER STATUS
# ══════════════════════════════════════════════════════════════════════════════
echo "── 7. Transfer Status ──────────────────────────"
R=$(req "$BASE/transfers/$INTERNAL_ID" -H "Authorization: Bearer $TOKEN")
S=$(status "$R"); B=$(body "$R")
check "GET /transfers/:id → 200"               200 "$S"
check_field "GET /transfers returns status"    "$(jq_val "$B" status)"
check_field "GET /transfers returns amount"    "$(jq_val "$B" amount)"

R=$(req "$BASE/transfers/00000000-0000-0000-0000-000000000000" -H "Authorization: Bearer $TOKEN")
check "GET /transfers/nonexistent → 404"       404 "$(status "$R")"

R=$(req "$BASE/transfers/$INTERNAL_ID")
check "GET /transfers no auth → 401"           401 "$(status "$R")"

echo ""

# ══════════════════════════════════════════════════════════════════════════════
# 8. RECEIVE (inter-bank)
# ══════════════════════════════════════════════════════════════════════════════
echo "── 8. Receive Inter-bank ───────────────────────"
R=$(req -X POST "$BASE/transfers/receive" \
    -H "Content-Type: application/json" -d '{}')
check "POST /transfers/receive missing jwt → 400" 400 "$(status "$R")"

R=$(req -X POST "$BASE/transfers/receive" \
    -H "Content-Type: application/json" -d '{"jwt":"invalid.jwt.token"}')
check "POST /transfers/receive bad jwt → 401"  401 "$(status "$R")"

echo ""

# ══════════════════════════════════════════════════════════════════════════════
# 9. API DOCS
# ══════════════════════════════════════════════════════════════════════════════
echo "── 9. API Documentation ────────────────────────"
R=$(req "$DOCS/api-docs.json")
check "GET /api-docs.json → 200"               200 "$(status "$R")"

R=$(req -L "$DOCS/api-docs")
check "GET /api-docs (Swagger UI) → 200"       200 "$(status "$R")"

echo ""

# ══════════════════════════════════════════════════════════════════════════════
# 10. RATE LIMITING
# ══════════════════════════════════════════════════════════════════════════════
echo "── 10. Rate Limiting ───────────────────────────"
FOUND_429=false
for i in $(seq 1 110); do
  S=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/users/$USERID" -H "Authorization: Bearer $TOKEN")
  if [ "$S" = "429" ]; then
    FOUND_429=true
    break
  fi
done
if $FOUND_429; then
  check "Rate limit 429 triggered" "429" "429"
else
  check "Rate limit 429 triggered" "429" "none"
fi

echo ""
echo "=============================================="
printf " Results: \033[32m%d passed\033[0m, \033[31m%d failed\033[0m / %d total\n" $PASS $FAIL $TOTAL
echo "=============================================="

[ $FAIL -eq 0 ]
