import express from 'express';
import swaggerUi from 'swagger-ui-express';
import fs from 'fs';
import path from 'path';
import YAML from 'yaml';
import { Pool } from 'pg';
import { authMiddleware } from './middleware/auth';
import { createProxyRouter } from './proxy';

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
});

// Rate limiting - simple in-memory (use Redis in production)
const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT = 100; // requests per minute
const RATE_WINDOW_MS = 60 * 1000;

function rateLimitMiddleware(req: express.Request, res: express.Response, next: express.NextFunction): void {
  // Skip rate limiting for health checks and swagger
  if (req.path === '/health' || req.path.startsWith('/api-docs')) {
    return next();
  }

  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  
  let record = rateLimitMap.get(ip);
  if (!record || now > record.resetTime) {
    record = { count: 0, resetTime: now + RATE_WINDOW_MS };
    rateLimitMap.set(ip, record);
  }
  
  record.count++;
  
  if (record.count > RATE_LIMIT) {
    res.status(429).json({ code: 'RATE_LIMITED', message: 'Too many requests. Please try again later.' });
    return;
  }
  
  next();
}

app.use(express.json());
app.use(rateLimitMiddleware);
app.use(express.static(path.join(process.cwd(), 'public')));

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', database: 'connected', timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ status: 'unhealthy', database: 'disconnected', timestamp: new Date().toISOString() });
  }
});

const swaggerDocument = YAML.parse(fs.readFileSync(path.join(process.cwd(), 'src', 'openapi.yaml'), 'utf8'));

app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

app.get('/api-docs.json', (_req, res) => {
  res.json(swaggerDocument);
});

app.get('/api/v1/api-docs.json', (_req, res) => {
  res.json(swaggerDocument);
});

app.get('/api/v1/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', database: 'connected', timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ status: 'unhealthy', database: 'disconnected', timestamp: new Date().toISOString() });
  }
});

const proxyRouter = createProxyRouter();
app.use('/api/v1', authMiddleware, proxyRouter);

// Graceful shutdown
let server: ReturnType<typeof app.listen> | null = null;

function gracefulShutdown(signal: string): void {
  console.log(`Received ${signal}, shutting down gracefully...`);
  
  if (server) {
    server.close(async () => {
      console.log('HTTP server closed');
      try {
        await pool.end();
        console.log('Health check pool closed');
        const { closeAuthPool } = await import('./middleware/auth');
        await closeAuthPool();
        console.log('Auth pool closed');
      } catch (err) {
        console.error('Error closing pools:', err);
      }
      process.exit(0);
    });
    
    // Force exit after 10 seconds
    setTimeout(() => {
      console.error('Forced shutdown after timeout');
      process.exit(1);
    }, 10000);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

server = app.listen(PORT, () => {
  console.log(`api-gateway listening on port ${PORT}`);
});
