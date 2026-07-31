import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.js';

let db;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- One row per article we've seen from any feed.
CREATE TABLE IF NOT EXISTS articles (
  id              INTEGER PRIMARY KEY,
  url             TEXT NOT NULL UNIQUE,
  guid            TEXT,
  source_id       TEXT NOT NULL,
  source_name     TEXT NOT NULL,
  source_tier     INTEGER NOT NULL DEFAULT 2,
  feed_category   TEXT,
  title           TEXT NOT NULL,
  feed_summary    TEXT,
  body            TEXT,
  body_source     TEXT,            -- 'extracted' | 'feed' | null
  word_count      INTEGER NOT NULL DEFAULT 0,
  published_at    INTEGER NOT NULL,
  first_seen_at   INTEGER NOT NULL,
  extracted_at    INTEGER,
  extract_failed  INTEGER NOT NULL DEFAULT 0,
  image_url       TEXT,
  cluster_id      INTEGER REFERENCES clusters(id) ON DELETE SET NULL,
  clustered_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_articles_published ON articles(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_articles_cluster   ON articles(cluster_id);
CREATE INDEX IF NOT EXISTS idx_articles_pending   ON articles(cluster_id, published_at)
  WHERE cluster_id IS NULL;

-- A cluster is one real-world event, with coverage from one or more outlets.
CREATE TABLE IF NOT EXISTS clusters (
  id                  INTEGER PRIMARY KEY,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  first_published_at  INTEGER NOT NULL,
  last_published_at   INTEGER NOT NULL,
  article_count       INTEGER NOT NULL DEFAULT 0,
  source_count        INTEGER NOT NULL DEFAULT 0,
  lead_title          TEXT,
  topic               TEXT,
  score               REAL NOT NULL DEFAULT 0,
  is_developing       INTEGER NOT NULL DEFAULT 0,
  needs_summary       INTEGER NOT NULL DEFAULT 1,
  summarized_at       INTEGER,
  summarized_articles INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_clusters_score   ON clusters(score DESC);
CREATE INDEX IF NOT EXISTS idx_clusters_updated ON clusters(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_clusters_pending ON clusters(needs_summary) WHERE needs_summary = 1;

-- The generated brief for a cluster. One row per cluster, replaced on regeneration.
CREATE TABLE IF NOT EXISTS summaries (
  cluster_id      INTEGER PRIMARY KEY REFERENCES clusters(id) ON DELETE CASCADE,
  headline        TEXT NOT NULL,
  one_liner       TEXT,
  what_happened   TEXT NOT NULL,
  why_it_matters  TEXT,
  current_status  TEXT,
  whats_new       TEXT,            -- delta vs the previous version, when updated
  topic           TEXT,
  importance      INTEGER NOT NULL DEFAULT 50,
  confidence      TEXT NOT NULL DEFAULT 'medium',
  generator       TEXT NOT NULL,   -- model id, or 'extractive-fallback'
  generated_at    INTEGER NOT NULL,
  verified        INTEGER NOT NULL DEFAULT 0,
  verification_note TEXT,
  source_count    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS summary_facts (
  id          INTEGER PRIMARY KEY,
  cluster_id  INTEGER NOT NULL REFERENCES summaries(cluster_id) ON DELETE CASCADE,
  ord         INTEGER NOT NULL,
  fact        TEXT NOT NULL,
  article_ids TEXT NOT NULL DEFAULT '[]',  -- JSON array of articles.id
  supported   INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_facts_cluster ON summary_facts(cluster_id, ord);

CREATE TABLE IF NOT EXISTS summary_people (
  id          INTEGER PRIMARY KEY,
  cluster_id  INTEGER NOT NULL REFERENCES summaries(cluster_id) ON DELETE CASCADE,
  ord         INTEGER NOT NULL,
  name        TEXT NOT NULL,
  role        TEXT
);
CREATE INDEX IF NOT EXISTS idx_people_cluster ON summary_people(cluster_id, ord);

-- Where sources disagree or the reporting is explicitly uncertain.
CREATE TABLE IF NOT EXISTS summary_disputes (
  id          INTEGER PRIMARY KEY,
  cluster_id  INTEGER NOT NULL REFERENCES summaries(cluster_id) ON DELETE CASCADE,
  ord         INTEGER NOT NULL,
  point       TEXT NOT NULL,
  detail      TEXT
);
CREATE INDEX IF NOT EXISTS idx_disputes_cluster ON summary_disputes(cluster_id, ord);

-- Append-only log of how a story changed over time.
CREATE TABLE IF NOT EXISTS story_updates (
  id             INTEGER PRIMARY KEY,
  cluster_id     INTEGER NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
  at             INTEGER NOT NULL,
  whats_new      TEXT NOT NULL,
  articles_added INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_updates_cluster ON story_updates(cluster_id, at DESC);

-- Per-feed health, so the UI can be honest about what's actually reachable.
CREATE TABLE IF NOT EXISTS feed_status (
  source_id      TEXT NOT NULL,
  feed_url       TEXT NOT NULL PRIMARY KEY,
  last_attempt   INTEGER,
  last_success   INTEGER,
  last_error     TEXT,
  items_last_run INTEGER NOT NULL DEFAULT 0,
  ok             INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS runs (
  id          INTEGER PRIMARY KEY,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  ok          INTEGER,
  stats       TEXT,
  error       TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at DESC);

-- Full-text search over headline + summary body, kept in sync by triggers.
CREATE VIRTUAL TABLE IF NOT EXISTS summaries_fts USING fts5(
  headline, one_liner, what_happened, why_it_matters,
  content='summaries', content_rowid='cluster_id'
);

CREATE TRIGGER IF NOT EXISTS summaries_ai AFTER INSERT ON summaries BEGIN
  INSERT INTO summaries_fts(rowid, headline, one_liner, what_happened, why_it_matters)
  VALUES (new.cluster_id, new.headline, new.one_liner, new.what_happened, new.why_it_matters);
END;
CREATE TRIGGER IF NOT EXISTS summaries_ad AFTER DELETE ON summaries BEGIN
  INSERT INTO summaries_fts(summaries_fts, rowid, headline, one_liner, what_happened, why_it_matters)
  VALUES ('delete', old.cluster_id, old.headline, old.one_liner, old.what_happened, old.why_it_matters);
END;
CREATE TRIGGER IF NOT EXISTS summaries_au AFTER UPDATE ON summaries BEGIN
  INSERT INTO summaries_fts(summaries_fts, rowid, headline, one_liner, what_happened, why_it_matters)
  VALUES ('delete', old.cluster_id, old.headline, old.one_liner, old.what_happened, old.why_it_matters);
  INSERT INTO summaries_fts(rowid, headline, one_liner, what_happened, why_it_matters)
  VALUES (new.cluster_id, new.headline, new.one_liner, new.what_happened, new.why_it_matters);
END;
`;

export function getDb() {
  if (db) return db;
  const dir = path.dirname(config.dbPath);
  if (dir && dir !== ':memory:' && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  db = new Database(config.dbPath);
  db.exec(SCHEMA);
  return db;
}

/** Used by the offline test suite to run the whole pipeline against a scratch DB. */
export function openDatabase(filePath) {
  const instance = new Database(filePath);
  instance.exec(SCHEMA);
  return instance;
}

export function setDb(instance) {
  db = instance;
}

export function closeDb() {
  if (db) {
    db.close();
    db = undefined;
  }
}
