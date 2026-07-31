import path from 'node:path';
import express from 'express';
import { createApiRouter } from './api/routes.js';
import { isAvailable } from './ai/client.js';
import { config, ROOT } from './config.js';
import { getDb } from './db.js';
import { logger } from './lib/log.js';
import { startScheduler, stopScheduler } from './pipeline/run.js';
import { allFeeds, SOURCES } from './sources.js';

const log = logger('server');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

app.use('/api', createApiRouter());

app.use(
  express.static(path.join(ROOT, 'public'), {
    maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
    extensions: ['html'],
  }),
);

app.get('/health', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

// Client-side routing: anything that isn't an API call or a real file is the app.
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
  return res.sendFile(path.join(ROOT, 'public', 'index.html'));
});

app.use((error, _req, res, _next) => {
  log.error(`unhandled: ${error?.stack || error}`);
  res.status(500).json({ error: 'Internal server error' });
});

getDb();

const server = app.listen(config.port, () => {
  log.info(`listening on http://localhost:${config.port}`);
  log.info(`${SOURCES.length} outlets, ${allFeeds().length} feeds configured`);
  if (isAvailable()) {
    log.info(`AI summarization enabled (${config.ai.model})`);
  } else {
    log.warn('ANTHROPIC_API_KEY is not set — running in extractive fallback mode.');
    log.warn('Stories will still be gathered, grouped and ranked, but summaries will be');
    log.warn('verbatim extracts rather than written briefings. Set the key and restart.');
  }
  startScheduler();
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log.info(`${signal} received, shutting down`);
    stopScheduler();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}

export { app, server };
