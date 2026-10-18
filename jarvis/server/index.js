import express from 'express';
import helmet from 'helmet';
import path from 'node:path';
import { config, ROOT } from './config.js';
import { authRouter, sessionMiddleware, requireAuth, csrfGuard } from './auth.js';
import { HttpError } from './http.js';
import { core } from './routes/core.js';
import { finance } from './routes/finance.js';
import { assistant } from './routes/assistant.js';
import { integrations, oauthCallback } from './routes/integrations.js';
import { startScheduler } from './scheduler.js';
import { providerStatus } from './ai/agent.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (config.isProd) app.set('trust proxy', 1);

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'"],
        'img-src': ["'self'", 'data:'],
        'connect-src': ["'self'"],
        'font-src': ["'self'"],
        'object-src': ["'none'"],
        'frame-ancestors': ["'none'"],
        'form-action': ["'self'"],
        'upgrade-insecure-requests': config.isProd ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
    hsts: config.isProd,
  }));
  app.use(express.json({ limit: '2mb' }));
  app.use(sessionMiddleware);

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use('/api', csrfGuard);
  app.use('/api/auth', authRouter);
  app.use('/api/integrations', oauthCallback);
  app.use('/api', requireAuth);
  app.use('/api', core);
  app.use('/api/finance', finance);
  app.use('/api/assistant', assistant);
  app.use('/api/integrations', integrations);
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found.')));

  app.get('/vendor/luxon.js', (_req, res) => res.type('text/javascript').sendFile(path.join(ROOT, 'node_modules/luxon/build/es6/luxon.mjs')));
  app.use(express.static(path.join(ROOT, 'public'), { index: 'index.html', maxAge: config.isProd ? '1h' : 0 }));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(ROOT, 'public/index.html')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err.type === 'entity.parse.failed') err = new HttpError(400, 'Malformed JSON body.');
    if (err.type === 'entity.too.large') err = new HttpError(413, 'Request body is too large.');
    if (err.name === 'ZodError') err = new HttpError(400, err.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '));
    if (!(err instanceof HttpError) && /^Invalid date/.test(err.message)) err = new HttpError(400, err.message);
    const status = err instanceof HttpError ? err.status : 500;
    if (status >= 500) console.error(`[${req.method} ${req.path}]`, err);
    res.status(status).json({ error: status >= 500 && !(err instanceof HttpError) ? 'Something went wrong on the server.' : err.message, details: err.details });
  });
  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(ROOT, 'server/index.js')) {
  const app = createApp();
  app.listen(config.port, () => {
    const ai = providerStatus();
    console.log(`JARVIS running at ${config.baseUrl}`);
    console.log(`  AI: ${ai.label}${ai.configured ? '' : ' — ' + ai.hint}`);
    console.log(`  Scheduler: ${config.scheduler.enabled ? `in-process, every ${config.scheduler.intervalMs / 1000}s` : 'disabled (run `npm run worker` separately)'}`);
  });
  startScheduler();
}
