import express from 'express';
import { logger } from '../lib/log.js';
import { isRunning, runCycle } from '../pipeline/run.js';
import { getStatus, getStory, listSources, listStories, listTopics } from './queries.js';

const log = logger('api');

export function createApiRouter() {
  const router = express.Router();

  router.get('/stories', (req, res) => {
    const limit = clampInt(req.query.limit, 30, 1, 100);
    const offset = clampInt(req.query.offset, 0, 0, 5000);
    const hours = req.query.hours ? clampInt(req.query.hours, 72, 1, 720) : null;

    const result = listStories({
      topic: typeof req.query.topic === 'string' ? req.query.topic : undefined,
      query: typeof req.query.q === 'string' ? req.query.q : undefined,
      limit,
      offset,
      since: hours ? Date.now() - hours * 3_600_000 : undefined,
    });

    res.json({ ...result, limit, offset });
  });

  router.get('/stories/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid story id' });
    const story = getStory(id);
    if (!story) return res.status(404).json({ error: 'Story not found' });
    return res.json(story);
  });

  router.get('/topics', (_req, res) => res.json(listTopics()));

  router.get('/sources', (_req, res) => res.json({ sources: listSources() }));

  router.get('/status', (_req, res) => res.json(getStatus()));

  // Manual refresh. Returns immediately — a full cycle involves dozens of
  // network round trips and must not be held open on an HTTP request.
  router.post('/refresh', (_req, res) => {
    if (isRunning()) {
      return res.status(409).json({ started: false, reason: 'A refresh is already running' });
    }
    runCycle({ reason: 'manual' }).catch((error) => {
      log.error(`manual refresh failed: ${error?.message || error}`);
    });
    return res.status(202).json({ started: true });
  });

  return router;
}

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}
