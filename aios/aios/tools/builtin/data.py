"""Spreadsheet and structured-data tools.

Deliberately built on ``sqlite3`` + ``csv`` from the standard library rather
than pandas. Two reasons, one practical and one architectural:

- a 200 MB CSV loaded into a DataFrame costs several GB of RAM, whereas
  streaming it into an on-disk SQLite table costs almost nothing;
- SQL is the right interface for a *planner* to target. "Compute revenue by
  region for Q3" becomes one generated query the verifier can inspect, rather
  than a chain of opaque transformation calls.

``data.query`` therefore accepts real SQL over one or more CSV/TSV/JSON files,
each mounted as a table. Statements are restricted to reads so a malformed
query cannot rewrite the user's data.
"""

from __future__ import annotations

import csv
import json
import re
import sqlite3
import statistics
from pathlib import Path
from typing import Any

from ...foundation.errors import InvalidArguments
from ...security import capabilities as caps
from ...security.capabilities import RiskLevel
from ...security.policy import ActionRequest
from ..base import Tool, ToolContext, ToolResult

_FORBIDDEN_SQL = re.compile(
    r"(?is)\b(attach|detach|pragma|insert|update|delete|drop|alter|create\s+(?!temp)|replace|vacuum)\b"
)
_IDENT = re.compile(r"[^a-zA-Z0-9_]")


def _sniff(path: Path) -> str:
    with path.open("r", encoding="utf-8", errors="replace", newline="") as fh:
        sample = fh.read(16384)
    if not sample.strip():
        raise InvalidArguments(f"{path.name} is empty")
    try:
        return csv.Sniffer().sniff(sample, delimiters=",;\t|").delimiter
    except csv.Error:
        return "\t" if path.suffix.lower() == ".tsv" else ","


def _read_rows(path: Path, limit: int | None = None) -> tuple[list[str], list[list[str]]]:
    if path.suffix.lower() == ".json":
        payload = json.loads(path.read_text("utf-8", errors="replace"))
        records = payload if isinstance(payload, list) else [payload]
        headers: list[str] = []
        for record in records:
            if isinstance(record, dict):
                for key in record:
                    if key not in headers:
                        headers.append(key)
        rows = [
            [_stringify(r.get(h)) if isinstance(r, dict) else "" for h in headers]
            for r in (records[:limit] if limit else records)
        ]
        return headers, rows

    delimiter = _sniff(path)
    with path.open("r", encoding="utf-8", errors="replace", newline="") as fh:
        reader = csv.reader(fh, delimiter=delimiter)
        try:
            headers = next(reader)
        except StopIteration as exc:
            raise InvalidArguments(f"{path.name} has no header row") from exc
        rows = []
        for index, row in enumerate(reader):
            if limit is not None and index >= limit:
                break
            rows.append(row)
    return [h.strip() for h in headers], rows


def _stringify(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    return json.dumps(value, default=str)


def _infer(values: list[str]) -> str:
    sample = [v for v in values if v not in ("", None)][:500]
    if not sample:
        return "empty"
    if all(_looks_int(v) for v in sample):
        return "integer"
    if all(_looks_float(v) for v in sample):
        return "number"
    if all(v.strip().lower() in {"true", "false", "yes", "no", "0", "1"} for v in sample):
        return "boolean"
    if all(re.match(r"^\d{4}-\d{2}-\d{2}", v.strip()) for v in sample):
        return "date"
    return "string"


def _looks_int(value: str) -> bool:
    text = value.strip().replace(",", "").replace("_", "")
    return bool(text) and (text[1:] if text[0] in "+-" else text).isdigit()


def _looks_float(value: str) -> bool:
    try:
        float(value.strip().replace(",", "").replace("$", "").replace("%", ""))
    except ValueError:
        return False
    return True


class InspectData(Tool):
    """Profile a tabular file: shape, types, nulls, distributions, outliers."""

    name = "data.inspect"
    summary = "Profile a CSV/TSV/JSON file: columns, types, null rates and statistics."
    tags = ("data", "spreadsheet", "read", "inspect", "analysis")
    capabilities = frozenset({caps.FS_READ})
    risk = RiskLevel.SAFE
    default_timeout = 180.0
    parameters = {
        "type": "object",
        "properties": {
            "path": {"type": "string"},
            "sample_rows": {"type": "integer", "minimum": 10, "default": 20000},
        },
        "required": ["path"],
        "additionalProperties": False,
    }

    def plan_action(self, args: dict[str, Any]) -> ActionRequest:
        action = super().plan_action(args)
        action.paths = [str(args.get("path", ""))]
        return action

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        path = ctx.jail.resolve(args["path"], must_exist=True)
        headers, rows = _read_rows(path, limit=int(args.get("sample_rows", 20000)))
        columns: list[dict[str, Any]] = []
        for index, header in enumerate(headers):
            values = [row[index] if index < len(row) else "" for row in rows]
            non_null = [v for v in values if v not in ("", None)]
            kind = _infer(values)
            entry: dict[str, Any] = {
                "name": header,
                "type": kind,
                "null_rate": round(1 - len(non_null) / len(values), 4) if values else 1.0,
                "distinct": len(set(non_null)),
                "examples": non_null[:3],
            }
            if kind in {"integer", "number"} and non_null:
                numbers = []
                for value in non_null:
                    try:
                        numbers.append(float(value.replace(",", "").replace("$", "").replace("%", "")))
                    except ValueError:
                        continue
                if numbers:
                    entry["stats"] = {
                        "min": min(numbers),
                        "max": max(numbers),
                        "mean": round(statistics.fmean(numbers), 4),
                        "median": statistics.median(numbers),
                        "stdev": round(statistics.pstdev(numbers), 4) if len(numbers) > 1 else 0.0,
                    }
            elif kind == "string" and non_null:
                counts: dict[str, int] = {}
                for value in non_null:
                    counts[value] = counts.get(value, 0) + 1
                entry["top_values"] = dict(sorted(counts.items(), key=lambda kv: -kv[1])[:8])
            columns.append(entry)

        issues: list[str] = []
        if len(set(headers)) != len(headers):
            issues.append("duplicate column names")
        widths = {len(r) for r in rows}
        if len(widths) > 1:
            issues.append(f"ragged rows: widths {sorted(widths)[:5]}")
        for column in columns:
            if column["null_rate"] > 0.5:
                issues.append(f"column {column['name']!r} is {column['null_rate']:.0%} empty")

        report = {
            "path": ctx.jail.relative(path),
            "rows_sampled": len(rows),
            "columns": columns,
            "column_count": len(headers),
            "issues": issues,
        }
        return ToolResult.success(
            report,
            summary=f"{len(rows)} rows x {len(headers)} columns, {len(issues)} data quality issue(s)",
            artifacts=[ctx.keep_text("data-profile.json", json.dumps(report, indent=2, default=str),
                                     media_type="application/json")],
        )


class QueryData(Tool):
    """Run SQL across one or more tabular files."""

    name = "data.query"
    summary = "Run a read-only SQL query over CSV/TSV/JSON files mounted as tables."
    tags = ("data", "spreadsheet", "read", "analysis", "compute")
    capabilities = frozenset({caps.FS_READ})
    risk = RiskLevel.SAFE
    default_timeout = 300.0
    parameters = {
        "type": "object",
        "properties": {
            "sources": {
                "type": "object",
                "description": 'Table name -> file path, e.g. {"sales": "data/sales.csv"}.',
            },
            "sql": {"type": "string", "minLength": 6},
            "max_rows": {"type": "integer", "minimum": 1, "default": 5000},
            "output_csv": {"type": "string", "description": "Optional path to save results."},
        },
        "required": ["sources", "sql"],
        "additionalProperties": False,
    }

    def plan_action(self, args: dict[str, Any]) -> ActionRequest:
        action = super().plan_action(args)
        action.paths = [str(p) for p in (args.get("sources") or {}).values()]
        if args.get("output_csv"):
            action.paths.append(str(args["output_csv"]))
            action.capabilities = frozenset({caps.FS_READ, caps.FS_WRITE})
        action.summary = f"sql: {str(args.get('sql', ''))[:160]}"
        return action

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        sql: str = args["sql"]
        if _FORBIDDEN_SQL.search(sql):
            raise InvalidArguments(
                "data.query is read-only; use SELECT/WITH statements only "
                "(no INSERT/UPDATE/DELETE/DROP/ATTACH/PRAGMA)"
            )
        sources: dict[str, str] = args["sources"]
        if not sources:
            raise InvalidArguments("at least one source table is required")

        connection = sqlite3.connect(":memory:")
        connection.row_factory = sqlite3.Row
        try:
            loaded: dict[str, int] = {}
            for table, relative in sources.items():
                safe = _IDENT.sub("_", str(table))
                path = ctx.jail.resolve(relative, must_exist=True)
                headers, rows = _read_rows(path)
                if not headers:
                    raise InvalidArguments(f"{relative} has no columns")
                columns = [_IDENT.sub("_", h) or f"col{i}" for i, h in enumerate(headers)]
                columns = _dedupe(columns)
                column_defs = ", ".join(f'"{column}" TEXT' for column in columns)
                connection.execute(f'CREATE TABLE "{safe}" ({column_defs})')
                placeholders = ", ".join("?" * len(columns))
                connection.executemany(
                    f'INSERT INTO "{safe}" VALUES ({placeholders})',
                    [_pad(row, len(columns)) for row in rows],
                )
                loaded[safe] = len(rows)
            connection.commit()

            try:
                cursor = connection.execute(sql)
            except sqlite3.Error as exc:
                raise InvalidArguments(
                    f"SQL error: {exc}",
                    context={"sql": sql, "tables": {k: v for k, v in loaded.items()}},
                    cause=exc,
                ) from exc
            limit = int(args.get("max_rows", 5000))
            fetched = cursor.fetchmany(limit + 1)
            truncated = len(fetched) > limit
            fetched = fetched[:limit]
            names = [d[0] for d in cursor.description] if cursor.description else []
            records = [dict(zip(names, row, strict=False)) for row in fetched]
        finally:
            connection.close()

        artifacts = []
        if args.get("output_csv") and records:
            destination = ctx.jail.resolve(args["output_csv"], write=True)
            destination.parent.mkdir(parents=True, exist_ok=True)
            with destination.open("w", encoding="utf-8", newline="") as fh:
                writer = csv.DictWriter(fh, fieldnames=names)
                writer.writeheader()
                writer.writerows(records)
            artifacts.append(ctx.keep_file(destination))

        return ToolResult.success(
            {"columns": names, "rows": records, "row_count": len(records),
             "truncated": truncated, "tables": loaded},
            summary=f"{len(records)} row(s) returned from {len(loaded)} table(s)",
            artifacts=artifacts,
        )


def _dedupe(names: list[str]) -> list[str]:
    seen: dict[str, int] = {}
    out = []
    for name in names:
        if name in seen:
            seen[name] += 1
            out.append(f"{name}_{seen[name]}")
        else:
            seen[name] = 0
            out.append(name)
    return out


def _pad(row: list[str], width: int) -> list[str]:
    return (row + [""] * width)[:width]


class WriteData(Tool):
    """Write records out as CSV or JSON."""

    name = "data.write"
    summary = "Write a list of records to a CSV or JSON file."
    tags = ("data", "spreadsheet", "write", "create")
    capabilities = frozenset({caps.FS_WRITE})
    risk = RiskLevel.LOW
    parameters = {
        "type": "object",
        "properties": {
            "path": {"type": "string"},
            "records": {"type": "array", "items": {"type": "object"}},
            "format": {"type": "string", "enum": ["csv", "json"], "default": "csv"},
        },
        "required": ["path", "records"],
        "additionalProperties": False,
    }

    def plan_action(self, args: dict[str, Any]) -> ActionRequest:
        action = super().plan_action(args)
        action.paths = [str(args.get("path", ""))]
        return action

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        destination = ctx.jail.resolve(args["path"], write=True)
        destination.parent.mkdir(parents=True, exist_ok=True)
        records: list[dict[str, Any]] = args["records"]
        fmt = args.get("format", "csv")
        if fmt == "json" or destination.suffix.lower() == ".json":
            destination.write_text(json.dumps(records, indent=2, default=str), encoding="utf-8")
        else:
            if not records:
                raise InvalidArguments("cannot write an empty CSV without columns")
            fieldnames: list[str] = []
            for record in records:
                for key in record:
                    if key not in fieldnames:
                        fieldnames.append(key)
            with destination.open("w", encoding="utf-8", newline="") as fh:
                writer = csv.DictWriter(fh, fieldnames=fieldnames, extrasaction="ignore")
                writer.writeheader()
                writer.writerows(records)
        return ToolResult.success(
            {"path": ctx.jail.relative(destination), "records": len(records),
             "bytes": destination.stat().st_size},
            summary=f"wrote {len(records)} record(s) to {destination.name}",
            artifacts=[ctx.keep_file(destination)],
        )


class CleanData(Tool):
    """Normalise a messy tabular file: trim, dedupe, coerce, drop empty columns."""

    name = "data.clean"
    summary = "Clean a tabular file: trim whitespace, drop duplicates and empty columns."
    tags = ("data", "spreadsheet", "write", "transform")
    capabilities = frozenset({caps.FS_READ, caps.FS_WRITE})
    risk = RiskLevel.LOW
    parameters = {
        "type": "object",
        "properties": {
            "path": {"type": "string"},
            "output": {"type": "string"},
            "drop_duplicates": {"type": "boolean", "default": True},
            "drop_empty_columns": {"type": "boolean", "default": True},
            "trim": {"type": "boolean", "default": True},
        },
        "required": ["path"],
        "additionalProperties": False,
    }

    def plan_action(self, args: dict[str, Any]) -> ActionRequest:
        action = super().plan_action(args)
        action.paths = [str(args.get("path", "")), str(args.get("output", ""))]
        action.paths = [p for p in action.paths if p]
        return action

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        source = ctx.jail.resolve(args["path"], must_exist=True)
        destination = ctx.jail.resolve(
            args.get("output") or source.with_name(f"{source.stem}.clean{source.suffix}"), write=True
        )
        headers, rows = _read_rows(source)
        report = {"input_rows": len(rows), "input_columns": len(headers)}

        if args.get("trim", True):
            headers = [h.strip() for h in headers]
            rows = [[(c or "").strip() for c in row] for row in rows]

        keep = list(range(len(headers)))
        if args.get("drop_empty_columns", True):
            keep = [
                i for i in range(len(headers))
                if headers[i] and any((row[i] if i < len(row) else "") for row in rows)
            ]
        headers = [headers[i] for i in keep]
        rows = [[row[i] if i < len(row) else "" for i in keep] for row in rows]

        if args.get("drop_duplicates", True):
            seen: set[tuple[str, ...]] = set()
            unique = []
            for row in rows:
                key = tuple(row)
                if key in seen:
                    continue
                seen.add(key)
                unique.append(row)
            rows = unique

        destination.parent.mkdir(parents=True, exist_ok=True)
        with destination.open("w", encoding="utf-8", newline="") as fh:
            writer = csv.writer(fh)
            writer.writerow(headers)
            writer.writerows(rows)

        report.update(
            {
                "output_rows": len(rows),
                "output_columns": len(headers),
                "rows_removed": report["input_rows"] - len(rows),
                "columns_removed": report["input_columns"] - len(headers),
                "path": ctx.jail.relative(destination),
            }
        )
        return ToolResult.success(
            report,
            summary=(
                f"cleaned to {len(rows)} rows x {len(headers)} cols "
                f"(-{report['rows_removed']} rows, -{report['columns_removed']} cols)"
            ),
            artifacts=[ctx.keep_file(destination)],
        )


def tools() -> list[Tool]:
    return [InspectData(), QueryData(), WriteData(), CleanData()]


__all__ = ["tools"]
