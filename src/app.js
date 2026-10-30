import express from 'express';
import { rateLimit } from 'express-rate-limit';
import crawlRouter, { serveScreenshot } from './routes/crawl.js';
import { CONFIG } from './config.js';

export function createApp() {
  const app = express();

  // Basic security and parsing
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  // Rate limiter: 20 requests/min per IP
  const limiter = rateLimit({
    windowMs: CONFIG.RATE_LIMIT_WINDOW_MS,
    max: CONFIG.RATE_LIMIT_MAX_REQUESTS,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' }
  });

  app.use('/api', limiter);

  // Mount API endpoints
  app.use('/api', crawlRouter);

  // Screenshot image serving
  app.get('/screenshots/:jobId/:file', serveScreenshot);

  // 404 handler
  app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
  });

  // Global error handler
  app.use((err, req, res, next) => {
    console.error('[API Error]', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
