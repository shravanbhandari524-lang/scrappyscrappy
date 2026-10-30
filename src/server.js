import { createApp } from './app.js';
import { CONFIG } from './config.js';

const port = process.env.PORT || CONFIG.PORT;
const app = createApp();

const server = app.listen(port, () => {
  console.log(`DeepCrawl API server listening on http://localhost:${port}`);
  console.log(`Rate limit: ${CONFIG.RATE_LIMIT_MAX_REQUESTS} req/min`);
  console.log(`Max depth cap: ${CONFIG.MAX_DEPTH_LIMIT}, Max pages cap: ${CONFIG.MAX_PAGES_LIMIT}`);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  server.close(() => {
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully...');
  server.close(() => {
    process.exit(0);
  });
});

export default server;
