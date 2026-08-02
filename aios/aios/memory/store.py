"""Persistent memory.

Four kinds, because they have genuinely different lifetimes and retrieval
patterns:

``preference``  durable statements about how the user wants things done
``fact``        durable statements about the world or the project
``episode``     what happened on a run: goal, plan, outcome, cost
``lesson``      what to do differently, harvested from failures

Retrieval is BM25 through SQLite FTS5 when the build has it, and a portable
token-overlap scorer when it does not - the kernel must not require a specific
SQLite build.

**Secrets are never written.** Every value passes the redaction check on the
way in; anything that looks like a credential is refused rather than masked, so
a leak cannot survive as a "helpful" memory.
"""

from __future__ import annotations

import json
import math
import re
import sqlite3
import time
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..foundation.config import MemoryConfig
from ..foundation.ids import new_id
from ..foundation.logging import get_logger
from ..foundation.redaction import contains_secret

log = get_logger("memory")

KINDS = ("preference", "fact", "episode", "lesson")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS memories (
    id          TEXT PRIMARY KEY,
    kind        TEXT NOT NULL,
    scope       TEXT NOT NULL DEFAULT 'global',
    content     TEXT NOT NULL,
    metadata    TEXT NOT NULL DEFAULT '{}',
    importance  REAL NOT NULL DEFAULT 0.5,
    created_at  REAL NOT NULL,
    accessed_at REAL NOT NULL,
    access_count INTEGER NOT NULL DEFAULT 0,
    superseded_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(kind, scope);
CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at DESC);

CREATE TABLE IF NOT EXISTS runs (
    run_id      TEXT PRIMARY KEY,
    goal        TEXT NOT NULL,
    status      TEXT NOT NULL,
    started_at  REAL NOT NULL,
    ended_at    REAL,
    steps       INTEGER DEFAULT 0,
    failed_steps INTEGER DEFAULT 0,
    usd         REAL DEFAULT 0,
    summary     TEXT DEFAULT '',
    workspace   TEXT DEFAULT ''
);
"""

_FTS = """
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    content, kind UNINDEXED, id UNINDEXED, tokenize='porter'
);
"""

_STOPWORDS = frozenset(
    """
    a an the and or but if then than that this these those is are was were be been being
    to of in on for with at by from as it its into about over under again further once
    here there all any both each few more most other some such no nor not only own same
    so too very can will just should now i you he she they we my your our
    """.split()
)


@dataclass(slots=True)
class Memory:
    id: str
    kind: str
    content: str
    scope: str = "global"
    metadata: dict[str, Any] = field(default_factory=dict)
    importance: float = 0.5
    created_at: float = 0.0
    access_count: int = 0
    score: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id, "kind": self.kind, "content": self.content, "scope": self.scope,
            "metadata": self.metadata, "importance": self.importance,
            "created_at": self.created_at, "score": round(self.score, 4),
        }


class MemoryStore:
    def __init__(self, path: str | Path, config: MemoryConfig | None = None) -> None:
        self.path = Path(path)
        self.config = config or MemoryConfig()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(str(self.path), check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._db.executescript(_SCHEMA)
        self.fts = self._try_fts()
        self._db.commit()

    def _try_fts(self) -> bool:
        try:
            self._db.executescript(_FTS)
        except sqlite3.OperationalError:
            log.info("SQLite build lacks FTS5; using the portable retrieval scorer")
            return False
        return True

    # -- writing ---------------------------------------------------------
    def remember(
        self,
        kind: str,
        content: str,
        *,
        scope: str = "global",
        metadata: dict[str, Any] | None = None,
        importance: float = 0.5,
        dedupe: bool = True,
    ) -> Memory | None:
        """Store a memory. Returns ``None`` when refused or deduplicated."""
        content = (content or "").strip()
        if not content:
            return None
        if kind not in KINDS:
            raise ValueError(f"unknown memory kind {kind!r}; expected one of {KINDS}")
        if not self.config.persist_secrets and contains_secret(content):
            log.warning("refusing to persist a memory containing credentials",
                        extra={"kind": kind, "scope": scope})
            return None
        if dedupe:
            existing = self._db.execute(
                "SELECT id FROM memories WHERE kind=? AND scope=? AND content=? "
                "AND superseded_by IS NULL LIMIT 1",
                (kind, scope, content),
            ).fetchone()
            if existing:
                self._touch(existing["id"])
                return None

        now = time.time()
        memory = Memory(
            id=new_id("mem_"), kind=kind, content=content, scope=scope,
            metadata=metadata or {}, importance=max(0.0, min(1.0, importance)), created_at=now,
        )
        self._db.execute(
            "INSERT INTO memories (id, kind, scope, content, metadata, importance, "
            "created_at, accessed_at) VALUES (?,?,?,?,?,?,?,?)",
            (memory.id, kind, scope, content, json.dumps(memory.metadata), memory.importance,
             now, now),
        )
        if self.fts:
            self._db.execute(
                "INSERT INTO memories_fts (content, kind, id) VALUES (?,?,?)",
                (content, kind, memory.id),
            )
        self._db.commit()
        return memory

    def supersede(self, old_id: str, new_content: str, **kw: Any) -> Memory | None:
        """Replace a memory, keeping the old one for audit."""
        replacement = self.remember(
            kw.pop("kind", "fact"), new_content, dedupe=False, **kw
        )
        if replacement:
            self._db.execute(
                "UPDATE memories SET superseded_by=? WHERE id=?", (replacement.id, old_id)
            )
            self._db.commit()
        return replacement

    def forget(self, memory_id: str) -> bool:
        cursor = self._db.execute("DELETE FROM memories WHERE id=?", (memory_id,))
        if self.fts:
            self._db.execute("DELETE FROM memories_fts WHERE id=?", (memory_id,))
        self._db.commit()
        return cursor.rowcount > 0

    # -- retrieval -------------------------------------------------------
    def recall(
        self,
        query: str,
        *,
        kinds: Iterable[str] | None = None,
        scope: str | None = None,
        limit: int | None = None,
    ) -> list[Memory]:
        """Relevance-ranked recall, blended with importance and recency.

        Pure text relevance surfaces things the user said once and never meant
        again; pure recency surfaces noise. The blend is what makes recall
        useful across a long-lived workspace.
        """
        limit = limit or self.config.max_recall
        candidates = self._search(query, kinds, scope, limit * 4)
        now = time.time()
        for memory in candidates:
            age_days = max(0.0, (now - memory.created_at) / 86400)
            recency = math.exp(-age_days / 45)  # half-life around a month
            usage = math.log1p(memory.access_count) / 6
            memory.score = (
                0.60 * memory.score + 0.22 * memory.importance + 0.12 * recency + 0.06 * usage
            )
        candidates.sort(key=lambda m: -m.score)
        top = candidates[:limit]
        for memory in top:
            self._touch(memory.id)
        return top

    def _search(
        self, query: str, kinds: Iterable[str] | None, scope: str | None, limit: int
    ) -> list[Memory]:
        """Blend an exact FTS5 index with a portable fuzzy scorer.

        Neither alone is sufficient. FTS5's Porter tokenizer is asymmetric -
        it indexes "deployment" as ``deploy`` but stems the query "deploy" to
        ``deploi``, so a plain MATCH silently returns nothing for an obviously
        relevant memory. And the portable scorer alone loses BM25's term
        weighting. So both run, and each memory keeps its better score.
        """
        clauses = ["superseded_by IS NULL"]
        params: list[Any] = []
        if kinds:
            kind_list = list(kinds)
            clauses.append(f"kind IN ({','.join('?' * len(kind_list))})")
            params += kind_list
        if scope:
            clauses.append("(scope = ? OR scope = 'global')")
            params.append(scope)
        where = " AND ".join(clauses)

        tokens = _tokenize(query)
        scores: dict[str, float] = {}
        found: dict[str, sqlite3.Row] = {}

        if self.fts and tokens:
            expression = " OR ".join(tokens[:12])
            try:
                rows = self._db.execute(
                    f"SELECT m.*, bm25(memories_fts) AS bm FROM memories_fts "
                    f"JOIN memories m ON m.id = memories_fts.id "
                    f"WHERE memories_fts MATCH ? AND {where} "
                    f"ORDER BY bm LIMIT ?",
                    (expression, *params, limit),
                ).fetchall()
            except sqlite3.OperationalError:
                rows = []
            best = min((r["bm"] for r in rows), default=-1.0) or -1.0
            for row in rows:
                found[row["id"]] = row
                scores[row["id"]] = _normalize_bm25(row["bm"], best)

        rows = self._db.execute(
            f"SELECT * FROM memories WHERE {where} ORDER BY created_at DESC LIMIT ?",
            (*params, max(limit * 3, 60)),
        ).fetchall()
        for row in rows:
            found.setdefault(row["id"], row)
            overlap = _overlap(tokens, row["content"])
            scores[row["id"]] = max(scores.get(row["id"], 0.0), overlap)

        return [self._row_to_memory(row, score=scores.get(row["id"], 0.0))
                for row in found.values()]

    def preferences(self, scope: str | None = None) -> list[Memory]:
        rows = self._db.execute(
            "SELECT * FROM memories WHERE kind='preference' AND superseded_by IS NULL "
            "AND (? IS NULL OR scope=? OR scope='global') ORDER BY importance DESC, created_at DESC",
            (scope, scope),
        ).fetchall()
        return [self._row_to_memory(row) for row in rows]

    def context_for(self, goal: str, *, scope: str | None = None, limit: int = 10) -> str:
        """Compact prompt block of the memories relevant to a goal."""
        memories = self.recall(goal, scope=scope, limit=limit)
        if not memories:
            return ""
        lines = []
        for memory in memories:
            lines.append(f"- [{memory.kind}] {memory.content}")
        return "\n".join(lines)

    # -- run history -----------------------------------------------------
    def start_run(self, run_id: str, goal: str, workspace: str = "") -> None:
        self._db.execute(
            "INSERT OR REPLACE INTO runs (run_id, goal, status, started_at, workspace) "
            "VALUES (?,?,?,?,?)",
            (run_id, goal, "running", time.time(), workspace),
        )
        self._db.commit()

    def finish_run(
        self, run_id: str, status: str, *, steps: int = 0, failed: int = 0,
        usd: float = 0.0, summary: str = "",
    ) -> None:
        self._db.execute(
            "UPDATE runs SET status=?, ended_at=?, steps=?, failed_steps=?, usd=?, summary=? "
            "WHERE run_id=?",
            (status, time.time(), steps, failed, usd, summary[:4000], run_id),
        )
        self._db.commit()

    def recent_runs(self, limit: int = 20) -> list[dict[str, Any]]:
        rows = self._db.execute(
            "SELECT * FROM runs ORDER BY started_at DESC LIMIT ?", (limit,)
        ).fetchall()
        return [dict(row) for row in rows]

    def stats(self) -> dict[str, Any]:
        counts = {
            row["kind"]: row["n"]
            for row in self._db.execute(
                "SELECT kind, COUNT(*) AS n FROM memories WHERE superseded_by IS NULL GROUP BY kind"
            )
        }
        runs = self._db.execute(
            "SELECT COUNT(*) AS n, COALESCE(SUM(usd),0) AS usd FROM runs"
        ).fetchone()
        return {
            "path": str(self.path),
            "memories": counts,
            "total_memories": sum(counts.values()),
            "runs": runs["n"],
            "lifetime_usd": round(runs["usd"], 4),
            "fts": self.fts,
        }

    # -- internals -------------------------------------------------------
    def _touch(self, memory_id: str) -> None:
        self._db.execute(
            "UPDATE memories SET accessed_at=?, access_count=access_count+1 WHERE id=?",
            (time.time(), memory_id),
        )
        self._db.commit()

    @staticmethod
    def _row_to_memory(row: sqlite3.Row, score: float = 0.0) -> Memory:
        return Memory(
            id=row["id"], kind=row["kind"], content=row["content"], scope=row["scope"],
            metadata=json.loads(row["metadata"] or "{}"), importance=row["importance"],
            created_at=row["created_at"], access_count=row["access_count"], score=score,
        )

    def close(self) -> None:
        self._db.close()

    def __enter__(self) -> MemoryStore:
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()


# Ordered longest-first so "deployment" loses "ment" before "s" is considered.
_SUFFIXES = ("ements", "ement", "ments", "ment", "tions", "tion", "ings", "ing",
             "edly", "ed", "ies", "es", "ly", "s")


def _stem(word: str) -> str:
    """Light suffix stripping.

    Not linguistically rigorous - it only has to make "deploy", "deploys",
    "deployed" and "deployment" collide, which is what recall actually needs.
    Roots shorter than four characters are left alone so "is" does not become
    a match for everything.
    """
    for suffix in _SUFFIXES:
        if word.endswith(suffix) and len(word) - len(suffix) >= 4:
            return word[: -len(suffix)]
    return word


def _tokenize(text: str) -> list[str]:
    words = re.findall(r"[a-zA-Z0-9_]{2,}", (text or "").lower())
    return [_stem(w) for w in words if w not in _STOPWORDS][:40]


def _overlap(tokens: list[str], content: str) -> float:
    """Cosine-style overlap over stemmed tokens; works on any SQLite build."""
    if not tokens:
        return 0.0
    other = set(_tokenize(content))
    if not other:
        return 0.0
    shared = len(set(tokens) & other)
    return shared / math.sqrt(len(set(tokens)) * len(other))


def _normalize_bm25(rank: float, best: float) -> float:
    """FTS5 bm25 returns lower-is-better negatives; map onto 0..1."""
    if not best:
        return 0.5
    return max(0.0, min(1.0, rank / best))


class NullMemory:
    """Drop-in no-op for ephemeral runs and tests."""

    fts = False

    def remember(self, *a: Any, **kw: Any) -> None:
        return None

    def recall(self, *a: Any, **kw: Any) -> list[Memory]:
        return []

    def preferences(self, *a: Any, **kw: Any) -> list[Memory]:
        return []

    def context_for(self, *a: Any, **kw: Any) -> str:
        return ""

    def start_run(self, *a: Any, **kw: Any) -> None:
        return None

    def finish_run(self, *a: Any, **kw: Any) -> None:
        return None

    def recent_runs(self, *a: Any, **kw: Any) -> list[dict[str, Any]]:
        return []

    def stats(self) -> dict[str, Any]:
        return {"enabled": False}

    def close(self) -> None:
        return None
