"""Content-addressed artifact store.

Steps hand their outputs to the store instead of passing paths around. That
buys three things the kernel depends on:

- **Immutability.** A later step cannot corrupt an earlier step's output, so
  retrying step 7 never invalidates the verified result of step 3.
- **Deduplication.** Identical bytes are stored once regardless of how many
  steps produced them.
- **Provenance.** Every artifact records which step produced it and which
  artifacts it derived from, so a run report can show a real lineage graph.

Large files are *referenced* rather than copied - a 4 GB video render should not
be duplicated into the blob store to satisfy a purity argument.
"""

from __future__ import annotations

import hashlib
import json
import mimetypes
import shutil
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from ..foundation.errors import InvalidArguments
from ..foundation.ids import new_id
from ..foundation.logging import get_logger

log = get_logger("runtime.artifacts")

COPY_THRESHOLD_BYTES = 64 * 1024 * 1024
_CHUNK = 1024 * 1024


@dataclass(slots=True)
class Artifact:
    id: str
    name: str
    kind: str  # file | text | json | directory
    sha256: str
    size: int
    media_type: str = "application/octet-stream"
    path: str = ""  # absolute path to the bytes (blob or referenced original)
    referenced: bool = False  # True when `path` is the original, not a blob copy
    produced_by: str | None = None  # step id
    derived_from: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)
    preview: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> Artifact:
        known = {f for f in cls.__slots__}  # type: ignore[attr-defined]
        return cls(**{k: v for k, v in payload.items() if k in known})

    def read_text(self, limit: int | None = None) -> str:
        data = Path(self.path).read_bytes()
        if limit is not None:
            data = data[:limit]
        return data.decode("utf-8", "replace")

    def read_json(self) -> Any:
        return json.loads(self.read_text())


class ArtifactStore:
    """Blobs live at ``<root>/ab/cdef...`` keyed by sha256."""

    def __init__(self, root: Path) -> None:
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self._index: dict[str, Artifact] = {}

    # -- ingestion -------------------------------------------------------
    def put_text(
        self,
        name: str,
        text: str,
        *,
        media_type: str = "text/plain",
        produced_by: str | None = None,
        derived_from: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> Artifact:
        data = text.encode("utf-8")
        digest = hashlib.sha256(data).hexdigest()
        blob = self._blob_path(digest)
        if not blob.exists():
            self._write_atomic(blob, data)
        artifact = Artifact(
            id=new_id("art_"),
            name=name,
            kind="text",
            sha256=digest,
            size=len(data),
            media_type=media_type,
            path=str(blob),
            produced_by=produced_by,
            derived_from=derived_from or [],
            metadata=metadata or {},
            preview=_preview(text),
        )
        return self._register(artifact)

    def put_json(self, name: str, payload: Any, **kw: Any) -> Artifact:
        text = json.dumps(payload, indent=2, default=str, ensure_ascii=False)
        artifact = self.put_text(name, text, media_type="application/json", **kw)
        artifact.kind = "json"
        return artifact

    def put_file(
        self,
        path: str | Path,
        *,
        name: str | None = None,
        produced_by: str | None = None,
        derived_from: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
        copy: bool | None = None,
    ) -> Artifact:
        source = Path(path)
        if not source.exists():
            raise InvalidArguments(f"artifact source does not exist: {source}")
        if source.is_dir():
            return self._put_directory(source, name, produced_by, metadata)

        size = source.stat().st_size
        digest = _hash_file(source)
        should_copy = size <= COPY_THRESHOLD_BYTES if copy is None else copy

        if should_copy:
            blob = self._blob_path(digest)
            if not blob.exists():
                tmp = blob.with_suffix(".tmp")
                blob.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, tmp)
                tmp.replace(blob)
            stored, referenced = blob, False
        else:
            stored, referenced = source.resolve(), True
            log.debug("referencing large artifact in place", extra={"size": size})

        media_type = mimetypes.guess_type(source.name)[0] or "application/octet-stream"
        artifact = Artifact(
            id=new_id("art_"),
            name=name or source.name,
            kind="file",
            sha256=digest,
            size=size,
            media_type=media_type,
            path=str(stored),
            referenced=referenced,
            produced_by=produced_by,
            derived_from=derived_from or [],
            metadata=metadata or {},
            preview=_file_preview(stored, media_type),
        )
        return self._register(artifact)

    def _put_directory(
        self,
        source: Path,
        name: str | None,
        produced_by: str | None,
        metadata: dict[str, Any] | None,
    ) -> Artifact:
        """Directories are recorded as a manifest, not copied."""
        entries: list[dict[str, Any]] = []
        total = 0
        hasher = hashlib.sha256()
        for child in sorted(source.rglob("*")):
            if child.is_file():
                rel = str(child.relative_to(source))
                digest = _hash_file(child)
                size = child.stat().st_size
                total += size
                entries.append({"path": rel, "sha256": digest, "size": size})
                hasher.update(f"{rel}:{digest}\n".encode())
        artifact = Artifact(
            id=new_id("art_"),
            name=name or source.name,
            kind="directory",
            sha256=hasher.hexdigest(),
            size=total,
            media_type="inode/directory",
            path=str(source.resolve()),
            referenced=True,
            produced_by=produced_by,
            metadata={**(metadata or {}), "files": entries[:2000], "file_count": len(entries)},
            preview=f"{len(entries)} files, {_human(total)}",
        )
        return self._register(artifact)

    # -- retrieval -------------------------------------------------------
    def get(self, artifact_id: str) -> Artifact | None:
        return self._index.get(artifact_id)

    def by_name(self, name: str) -> list[Artifact]:
        return [a for a in self._index.values() if a.name == name]

    def all(self) -> list[Artifact]:
        return list(self._index.values())

    def lineage(self, artifact_id: str) -> list[Artifact]:
        """Transitive ancestors, nearest first, cycle-safe."""
        out: list[Artifact] = []
        seen: set[str] = set()
        frontier = [artifact_id]
        while frontier:
            current = frontier.pop(0)
            artifact = self._index.get(current)
            if artifact is None or current in seen:
                continue
            seen.add(current)
            if current != artifact_id:
                out.append(artifact)
            frontier.extend(artifact.derived_from)
        return out

    def manifest(self) -> list[dict[str, Any]]:
        return [a.to_dict() for a in self._index.values()]

    def load_manifest(self, entries: list[dict[str, Any]]) -> None:
        for entry in entries:
            artifact = Artifact.from_dict(entry)
            self._index[artifact.id] = artifact

    # -- internals -------------------------------------------------------
    def _register(self, artifact: Artifact) -> Artifact:
        self._index[artifact.id] = artifact
        return artifact

    def _blob_path(self, digest: str) -> Path:
        return self.root / digest[:2] / digest[2:]

    @staticmethod
    def _write_atomic(target: Path, data: bytes) -> None:
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_suffix(".tmp")
        tmp.write_bytes(data)
        tmp.replace(target)


def _hash_file(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as fh:
        while chunk := fh.read(_CHUNK):
            hasher.update(chunk)
    return hasher.hexdigest()


def _preview(text: str, limit: int = 400) -> str:
    text = text.strip()
    return text if len(text) <= limit else text[:limit] + "…"


def _file_preview(path: Path, media_type: str) -> str:
    if media_type.startswith("text/") or media_type in {"application/json", "application/xml"}:
        try:
            with path.open("r", encoding="utf-8", errors="replace") as fh:
                return _preview(fh.read(2048))
        except OSError:  # pragma: no cover
            return ""
    return f"{media_type}, {_human(path.stat().st_size)}"


def _human(size: int) -> str:
    value = float(size)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if value < 1024 or unit == "TB":
            return f"{value:.0f}{unit}" if unit == "B" else f"{value:.1f}{unit}"
        value /= 1024
    return f"{value:.1f}TB"  # pragma: no cover
