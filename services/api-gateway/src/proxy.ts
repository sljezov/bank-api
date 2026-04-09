import { Router, Request, Response } from 'express';

const USER_SERVICE_URL = process.env.USER_SERVICE_URL || 'http://user-service:3001';
const ACCOUNT_SERVICE_URL = process.env.ACCOUNT_SERVICE_URL || 'http://account-service:3002';
const TRANSFER_SERVICE_URL = process.env.TRANSFER_SERVICE_URL || 'http://transfer-service:3003';

async function proxyRequest(
  req: Request,
  res: Response,
  targetUrl: string
): Promise<void> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (req.headers['x-user-id']) {
    headers['x-user-id'] = req.headers['x-user-id'] as string;
  }

  if (req.headers['x-path-user-id']) {
    headers['x-path-user-id'] = req.headers['x-path-user-id'] as string;
  }

  try {
    const fetchRes = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body),
    });

    const data = await fetchRes.json();
    res.status(fetchRes.status).json(data);
  } catch (err) {
    console.error(`Proxy error to ${targetUrl}:`, err);
    res.status(503).json({ code: 'SERVICE_UNAVAILABLE', message: 'Upstream service unavailable' });
  }
}

export function createProxyRouter(): Router {
  const router = Router();

  // User routes
  router.post('/users', (req, res) => {
    proxyRequest(req, res, `${USER_SERVICE_URL}/users`);
  });

  router.get('/users/:userId', (req, res) => {
    proxyRequest(req, res, `${USER_SERVICE_URL}/users/${req.params.userId}`);
  });

  // Account routes — pass path userId as header so account-service can verify ownership
  router.post('/users/:userId/accounts', (req, res) => {
    req.headers['x-path-user-id'] = req.params.userId;
    proxyRequest(req, res, `${ACCOUNT_SERVICE_URL}/accounts`);
  });

  router.get('/accounts/:accountNumber', (req, res) => {
    proxyRequest(req, res, `${ACCOUNT_SERVICE_URL}/accounts/${req.params.accountNumber}`);
  });

  // Transfer routes
  router.post('/transfers', (req, res) => {
    proxyRequest(req, res, `${TRANSFER_SERVICE_URL}/transfers`);
  });

  router.post('/transfers/receive', (req, res) => {
    proxyRequest(req, res, `${TRANSFER_SERVICE_URL}/transfers/receive`);
  });

  router.get('/transfers/:transferId', (req, res) => {
    proxyRequest(req, res, `${TRANSFER_SERVICE_URL}/transfers/${req.params.transferId}`);
  });

  return router;
}
