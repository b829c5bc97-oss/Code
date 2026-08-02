"""Code intelligence tools.

The tools an agent needs to work on software the way an engineer does: run
code, run the tests, and *understand* a codebase rather than grepping it.

``code.analyze`` is the interesting one. It builds a real symbol table from the
Python AST - definitions, imports, call graph edges, cyclomatic complexity and
near-duplicate function bodies - because "don't duplicate logic" and "keep the
architecture clean" are only enforceable if something can actually see the
structure.
"""

from __future__ import annotations

import ast
import asyncio
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any

from ...foundation.errors import ToolExecutionError
from ...security import capabilities as caps
from ...security.capabilities import RiskLevel
from ...security.policy import ActionRequest
from ..base import Tool, ToolContext, ToolResult
from .shell import _build_env

_SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "build", ".aios"}


class RunPython(Tool):
    """Execute a Python snippet in a fresh subprocess.

    A subprocess, not ``exec``: a snippet that segfaults, leaks memory or calls
    ``sys.exit`` must not be able to take the OS down with it.
    """

    name = "code.python"
    summary = "Run a Python script in the workspace and capture stdout/stderr/result."
    tags = ("code", "execute", "compute", "data")
    capabilities = frozenset({caps.PROCESS_SPAWN})
    risk = RiskLevel.MODERATE
    idempotent = False
    default_timeout = 300.0
    parameters = {
        "type": "object",
        "properties": {
            "code": {"type": "string", "minLength": 1},
            "cwd": {"type": "string", "default": "."},
            "timeout": {"type": "number", "minimum": 1, "default": 120},
            "argv": {"type": "array", "items": {"type": "string"}, "default": []},
        },
        "required": ["code"],
        "additionalProperties": False,
    }

    def plan_action(self, args: dict[str, Any]) -> ActionRequest:
        action = super().plan_action(args)
        action.paths = [str(args.get("cwd", "."))]
        action.summary = f"run python ({len(str(args.get('code', '')).splitlines())} lines)"
        action.reversible = False
        return action

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        cwd = ctx.jail.resolve(args.get("cwd", "."), must_exist=True)
        script = ctx.scratch / f"snippet-{(ctx.step_id or 'adhoc')[-8:]}.py"
        script.parent.mkdir(parents=True, exist_ok=True)
        script.write_text(args["code"], encoding="utf-8")

        timeout = min(float(args.get("timeout", 120)), ctx.remaining_seconds() or 1e9)
        env = _build_env(ctx, {"PYTHONUNBUFFERED": "1", "PYTHONDONTWRITEBYTECODE": "1"})
        process = await asyncio.create_subprocess_exec(
            sys.executable, str(script), *[str(a) for a in args.get("argv", [])],
            cwd=str(cwd), env=env,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            stdin=asyncio.subprocess.DEVNULL, start_new_session=True,
        )
        try:
            out, err = await asyncio.wait_for(process.communicate(), timeout=timeout)
        except TimeoutError:
            process.kill()
            await process.wait()
            raise
        stdout = out.decode("utf-8", "replace")
        stderr = err.decode("utf-8", "replace")
        code = process.returncode or 0
        if code != 0:
            return ToolResult.failure(
                ToolExecutionError(
                    f"python exited with status {code}",
                    context={"traceback": stderr[-3000:], "stdout_tail": stdout[-1000:]},
                ),
                summary=f"python failed (exit {code})",
            )
        return ToolResult.success(
            {"stdout": stdout, "stderr": stderr, "exit_code": code},
            summary=f"python ok, {len(stdout)} chars of output",
            metrics={"exit_code": code},
        )


class RunTests(Tool):
    """Detect and run the project's test suite, parsing the result."""

    name = "code.test"
    summary = "Detect and run the project's tests; returns pass/fail counts and failures."
    tags = ("code", "test", "verify", "execute")
    capabilities = frozenset({caps.SHELL_EXEC, caps.PROCESS_SPAWN})
    risk = RiskLevel.MODERATE
    default_timeout = 1800.0
    parameters = {
        "type": "object",
        "properties": {
            "path": {"type": "string", "default": "."},
            "command": {"type": "string", "description": "Override auto-detection."},
            "timeout": {"type": "number", "minimum": 5, "default": 900},
        },
        "additionalProperties": False,
    }

    def plan_action(self, args: dict[str, Any]) -> ActionRequest:
        action = super().plan_action(args)
        action.paths = [str(args.get("path", "."))]
        action.command = str(args.get("command", "")) or "<detected test command>"
        return action

    @staticmethod
    def detect(root: Path) -> str | None:
        if (root / "pytest.ini").exists() or (root / "tests").is_dir() or (root / "conftest.py").exists():
            return f"{Path(sys.executable).name} -m pytest -q"
        if (root / "pyproject.toml").exists():
            text = (root / "pyproject.toml").read_text("utf-8", errors="replace")
            if "pytest" in text:
                return f"{Path(sys.executable).name} -m pytest -q"
        if (root / "package.json").exists():
            try:
                manifest = json.loads((root / "package.json").read_text("utf-8"))
            except json.JSONDecodeError:
                manifest = {}
            if "test" in (manifest.get("scripts") or {}):
                return "npm test --silent"
        if (root / "go.mod").exists():
            return "go test ./..."
        if (root / "Cargo.toml").exists():
            return "cargo test"
        if (root / "Makefile").exists() and re.search(
            r"^test:", (root / "Makefile").read_text("utf-8", errors="replace"), re.M
        ):
            return "make test"
        return None

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        root = ctx.jail.resolve(args.get("path", "."), must_exist=True)
        command = args.get("command") or self.detect(root)
        if not command:
            raise ToolExecutionError(
                "could not detect a test command for this project; pass `command` explicitly",
                context={"path": str(root)},
            )
        timeout = min(float(args.get("timeout", 900)), ctx.remaining_seconds() or 1e9)
        process = await asyncio.create_subprocess_shell(
            command, cwd=str(root), env=_build_env(ctx, {}),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
            stdin=asyncio.subprocess.DEVNULL, start_new_session=True,
        )
        try:
            out, _ = await asyncio.wait_for(process.communicate(), timeout=timeout)
        except TimeoutError:
            process.kill()
            await process.wait()
            raise
        output = out.decode("utf-8", "replace")
        stats = _parse_test_output(output)
        exit_code = process.returncode or 0
        payload = {
            "command": command,
            "exit_code": exit_code,
            "output_tail": output[-8000:],
            **stats,
        }
        if exit_code != 0:
            return ToolResult.failure(
                ToolExecutionError(
                    f"tests failed ({stats.get('failed', '?')} failing)",
                    context={"command": command, "failures": stats.get("failures", [])[:10],
                             "output_tail": output[-4000:]},
                ),
                summary=f"tests failed: {stats.get('passed', 0)} passed, {stats.get('failed', 0)} failed",
                metrics=stats,
            )
        return ToolResult.success(
            payload,
            summary=f"tests passed: {stats.get('passed', 0)} passed, {stats.get('skipped', 0)} skipped",
            metrics=stats,
        )


def _parse_test_output(output: str) -> dict[str, Any]:
    """Extract counts from pytest / jest / go test output."""
    stats: dict[str, Any] = {}
    if match := re.search(r"(\d+) passed", output):
        stats["passed"] = int(match.group(1))
    if match := re.search(r"(\d+) failed", output):
        stats["failed"] = int(match.group(1))
    if match := re.search(r"(\d+) skipped", output):
        stats["skipped"] = int(match.group(1))
    if match := re.search(r"(\d+) error", output):
        stats["errors"] = int(match.group(1))
    # jest
    if match := re.search(r"Tests:\s+(?:(\d+) failed,\s*)?(?:(\d+) skipped,\s*)?(\d+) passed", output):
        stats.setdefault("failed", int(match.group(1) or 0))
        stats.setdefault("skipped", int(match.group(2) or 0))
        stats.setdefault("passed", int(match.group(3)))
    failures = re.findall(r"^(?:FAILED|--- FAIL:|\s*✕)\s*(.+)$", output, re.M)
    if failures:
        stats["failures"] = [f.strip()[:200] for f in failures[:50]]
    stats.setdefault("passed", 0)
    stats.setdefault("failed", len(stats.get("failures", [])))
    return stats


class AnalyzeCode(Tool):
    """Structural analysis of a Python codebase."""

    name = "code.analyze"
    summary = "Map a Python codebase: symbols, imports, complexity and duplicate logic."
    tags = ("code", "inspect", "read", "architecture")
    capabilities = frozenset({caps.FS_READ})
    risk = RiskLevel.SAFE
    default_timeout = 180.0
    parameters = {
        "type": "object",
        "properties": {
            "path": {"type": "string", "default": "."},
            "max_files": {"type": "integer", "minimum": 1, "default": 400},
            "complexity_threshold": {"type": "integer", "minimum": 1, "default": 12},
        },
        "additionalProperties": False,
    }

    def plan_action(self, args: dict[str, Any]) -> ActionRequest:
        action = super().plan_action(args)
        action.paths = [str(args.get("path", "."))]
        return action

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        root = ctx.jail.resolve(args.get("path", "."), must_exist=True)
        files = [root] if root.is_file() else sorted(root.rglob("*.py"))
        files = [
            f for f in files if not any(part in _SKIP_DIRS for part in f.relative_to(root).parts)
        ][: int(args.get("max_files", 400))]

        modules: list[dict[str, Any]] = []
        imports: dict[str, int] = {}
        bodies: dict[str, list[str]] = {}
        complex_functions: list[dict[str, Any]] = []
        threshold = int(args.get("complexity_threshold", 12))
        errors: list[dict[str, str]] = []
        total_lines = 0

        for file in files:
            try:
                source = file.read_text("utf-8", errors="replace")
                tree = ast.parse(source, filename=str(file))
            except (OSError, SyntaxError) as exc:
                errors.append({"file": str(file.relative_to(root) if root.is_dir() else file.name),
                               "error": str(exc)})
                continue
            rel = str(file.relative_to(root)) if root.is_dir() else file.name
            lines = source.count("\n") + 1
            total_lines += lines
            entry: dict[str, Any] = {
                "path": rel, "lines": lines, "classes": [], "functions": [], "imports": []
            }
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    for alias in node.names:
                        top = alias.name.split(".")[0]
                        imports[top] = imports.get(top, 0) + 1
                        entry["imports"].append(alias.name)
                elif isinstance(node, ast.ImportFrom) and node.module:
                    top = node.module.split(".")[0]
                    imports[top] = imports.get(top, 0) + 1
                    entry["imports"].append(node.module)
                elif isinstance(node, ast.ClassDef):
                    entry["classes"].append(
                        {"name": node.name, "line": node.lineno,
                         "methods": [n.name for n in node.body
                                     if isinstance(n, ast.FunctionDef | ast.AsyncFunctionDef)]}
                    )
                elif isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef):
                    score = _complexity(node)
                    entry["functions"].append(
                        {"name": node.name, "line": node.lineno, "complexity": score,
                         "args": len(node.args.args)}
                    )
                    if score >= threshold:
                        complex_functions.append(
                            {"file": rel, "function": node.name, "line": node.lineno,
                             "complexity": score}
                        )
                    digest = _body_fingerprint(node)
                    if digest:
                        bodies.setdefault(digest, []).append(f"{rel}:{node.name}:{node.lineno}")
            modules.append(entry)

        duplicates = [
            {"fingerprint": digest, "occurrences": places}
            for digest, places in bodies.items()
            if len(places) > 1
        ]
        duplicates.sort(key=lambda d: -len(d["occurrences"]))
        complex_functions.sort(key=lambda f: -f["complexity"])

        report = {
            "root": ctx.jail.relative(root),
            "files": len(modules),
            "total_lines": total_lines,
            "symbols": {
                "classes": sum(len(m["classes"]) for m in modules),
                "functions": sum(len(m["functions"]) for m in modules),
            },
            "top_imports": dict(sorted(imports.items(), key=lambda kv: -kv[1])[:25]),
            "high_complexity": complex_functions[:25],
            "duplicate_logic": duplicates[:25],
            "parse_errors": errors[:25],
            "modules": modules[:200],
        }
        artifact = ctx.keep_text(
            "code-analysis.json", json.dumps(report, indent=2), media_type="application/json"
        )
        return ToolResult.success(
            report,
            summary=(
                f"{len(modules)} modules, {report['symbols']['functions']} functions, "
                f"{len(duplicates)} duplicate block(s), {len(complex_functions)} complex function(s)"
            ),
            artifacts=[artifact],
        )


def _complexity(node: ast.AST) -> int:
    """Cyclomatic complexity: one plus every branch point."""
    score = 1
    for child in ast.walk(node):
        if isinstance(child, ast.If | ast.For | ast.AsyncFor | ast.While | ast.ExceptHandler
                      | ast.With | ast.AsyncWith | ast.Assert | ast.IfExp):
            score += 1
        elif isinstance(child, ast.BoolOp):
            score += len(child.values) - 1
        elif isinstance(child, ast.Match):
            score += len(child.cases)
        elif isinstance(child, ast.comprehension):
            score += 1 + len(child.ifs)
    return score


def _body_fingerprint(node: ast.FunctionDef | ast.AsyncFunctionDef) -> str | None:
    """Structural hash of a function body, ignoring names and literals.

    Two functions that differ only in identifiers produce the same digest,
    which is what surfaces copy-paste logic that a text diff would miss.
    """
    body = [n for n in node.body if not isinstance(n, ast.Expr | ast.Pass)]
    if len(body) < 4:
        return None  # too small for duplication to be meaningful
    shape = "|".join(type(n).__name__ for n in ast.walk(node) if not isinstance(n, ast.Name | ast.Constant | ast.Load | ast.Store))
    if len(shape) < 60:
        return None
    return hashlib.sha256(shape.encode()).hexdigest()[:16]


class FormatCode(Tool):
    """Run the project's formatter/linter if one is available."""

    name = "code.format"
    summary = "Format or lint the codebase using whichever tool the project provides."
    tags = ("code", "quality", "execute")
    capabilities = frozenset({caps.SHELL_EXEC, caps.PROCESS_SPAWN, caps.FS_WRITE})
    risk = RiskLevel.LOW
    default_timeout = 300.0
    parameters = {
        "type": "object",
        "properties": {
            "path": {"type": "string", "default": "."},
            "check_only": {"type": "boolean", "default": False},
        },
        "additionalProperties": False,
    }

    CANDIDATES = (
        ("ruff", "ruff format {path}", "ruff format --check {path}"),
        ("black", "black {path}", "black --check {path}"),
        ("prettier", "npx --no-install prettier --write {path}", "npx --no-install prettier --check {path}"),
        ("gofmt", "gofmt -w {path}", "gofmt -l {path}"),
        ("cargo", "cargo fmt", "cargo fmt --check"),
    )

    def plan_action(self, args: dict[str, Any]) -> ActionRequest:
        action = super().plan_action(args)
        action.paths = [str(args.get("path", "."))]
        return action

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        import shutil as _shutil

        root = ctx.jail.resolve(args.get("path", "."), must_exist=True)
        check = bool(args.get("check_only", False))
        for binary, write_cmd, check_cmd in self.CANDIDATES:
            if not _shutil.which(binary):
                continue
            command = (check_cmd if check else write_cmd).format(path=".")
            process = await asyncio.create_subprocess_shell(
                command, cwd=str(root), env=_build_env(ctx, {}),
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
                stdin=asyncio.subprocess.DEVNULL,
            )
            out, _ = await asyncio.wait_for(process.communicate(), timeout=240)
            output = out.decode("utf-8", "replace")
            ok = (process.returncode or 0) == 0
            return ToolResult(
                ok=ok or not check,
                output={"formatter": binary, "command": command, "exit_code": process.returncode,
                        "output": output[-4000:]},
                summary=f"{binary}: {'clean' if ok else 'changes needed'}",
                error=None if ok or not check else ToolExecutionError(
                    f"{binary} reported formatting issues", context={"output": output[-2000:]}
                ),
            )
        raise ToolExecutionError(
            "no formatter available (looked for ruff, black, prettier, gofmt, cargo fmt)"
        )


class ProjectScaffold(Tool):
    """Create a runnable project skeleton with sane, current defaults."""

    name = "code.scaffold"
    summary = "Create a project skeleton (static site, python-cli, python-api, node-api)."
    tags = ("code", "create", "write", "project")
    capabilities = frozenset({caps.FS_WRITE})
    risk = RiskLevel.LOW
    parameters = {
        "type": "object",
        "properties": {
            "path": {"type": "string"},
            "kind": {"type": "string",
                     "enum": ["static-site", "python-cli", "python-api", "node-api"]},
            "name": {"type": "string", "default": "app"},
            "description": {"type": "string", "default": ""},
        },
        "required": ["path", "kind"],
        "additionalProperties": False,
    }

    def plan_action(self, args: dict[str, Any]) -> ActionRequest:
        action = super().plan_action(args)
        action.paths = [str(args.get("path", ""))]
        return action

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        root = ctx.jail.resolve(args["path"], write=True)
        root.mkdir(parents=True, exist_ok=True)
        name = str(args.get("name") or root.name or "app")
        description = str(args.get("description") or f"{name} project")
        files = _SCAFFOLDS[args["kind"]](name, description)
        written: list[str] = []
        for rel, content in files.items():
            target = ctx.jail.resolve(root / rel, write=True)
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.exists():
                continue
            target.write_text(content, encoding="utf-8")
            written.append(str(target.relative_to(root)))
        artifact = ctx.artifacts.put_file(root, name=name, produced_by=ctx.step_id)
        return ToolResult.success(
            {"path": ctx.jail.relative(root), "kind": args["kind"], "files": written},
            summary=f"scaffolded {args['kind']} at {ctx.jail.relative(root)} ({len(written)} files)",
            artifacts=[artifact],
        )


def _static_site(name: str, description: str) -> dict[str, str]:
    return {
        "index.html": f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{name}</title>
<meta name="description" content="{description}">
<link rel="stylesheet" href="styles.css">
</head>
<body>
<header><h1>{name}</h1><p>{description}</p></header>
<main id="app"></main>
<script src="app.js" type="module"></script>
</body>
</html>
""",
        "styles.css": """:root { color-scheme: light dark; --fg: #14161a; --bg: #fbfbfd; --accent: #3d5afe; }
@media (prefers-color-scheme: dark) { :root { --fg: #e8eaf0; --bg: #0e1014; } }
* { box-sizing: border-box; }
body { margin: 0; font: 16px/1.6 system-ui, sans-serif; color: var(--fg); background: var(--bg); }
header, main { max-width: 68ch; margin: 0 auto; padding: 2rem 1.25rem; }
""",
        "app.js": "document.getElementById('app').textContent = 'Ready.';\n",
        "README.md": f"# {name}\n\n{description}\n\n## Run\n\n```bash\npython3 -m http.server 8000\n```\n",
    }


def _python_cli(name: str, description: str) -> dict[str, str]:
    module = re.sub(r"[^a-z0-9_]", "_", name.lower())
    return {
        "pyproject.toml": f"""[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[project]
name = "{module}"
version = "0.1.0"
description = "{description}"
requires-python = ">=3.11"

[project.scripts]
{module} = "{module}.cli:main"

[tool.pytest.ini_options]
testpaths = ["tests"]
""",
        f"{module}/__init__.py": '__version__ = "0.1.0"\n',
        f"{module}/cli.py": f'''"""Command line entry point for {name}."""

from __future__ import annotations

import argparse
import sys


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="{module}", description="{description}")
    parser.add_argument("--name", default="world")
    args = parser.parse_args(argv)
    print(f"hello, {{args.name}}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
''',
        "tests/test_cli.py": f"""from {module}.cli import main


def test_main_returns_zero(capsys):
    assert main(["--name", "aios"]) == 0
    assert "hello, aios" in capsys.readouterr().out
""",
        "README.md": f"# {name}\n\n{description}\n\n```bash\npip install -e .\n{module} --name you\npytest\n```\n",
    }


def _python_api(name: str, description: str) -> dict[str, str]:
    module = re.sub(r"[^a-z0-9_]", "_", name.lower())
    return {
        "requirements.txt": "fastapi>=0.111\nuvicorn>=0.30\npytest>=8.0\nhttpx>=0.27\n",
        f"{module}/__init__.py": "",
        f"{module}/main.py": f'''"""{description}"""

from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI(title="{name}", description="{description}")


class Health(BaseModel):
    status: str
    version: str


@app.get("/health", response_model=Health)
async def health() -> Health:
    return Health(status="ok", version="0.1.0")
''',
        "tests/test_main.py": f"""from fastapi.testclient import TestClient

from {module}.main import app

client = TestClient(app)


def test_health():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"
""",
        "README.md": f"# {name}\n\n{description}\n\n```bash\npip install -r requirements.txt\nuvicorn {module}.main:app --reload\n```\n",
    }


def _node_api(name: str, description: str) -> dict[str, str]:
    return {
        "package.json": json.dumps(
            {
                "name": re.sub(r"[^a-z0-9\-]", "-", name.lower()),
                "version": "0.1.0",
                "description": description,
                "type": "module",
                "main": "src/server.js",
                "scripts": {"start": "node src/server.js", "test": "node --test"},
            },
            indent=2,
        ) + "\n",
        "src/server.js": f"""import {{ createServer }} from 'node:http';

const port = process.env.PORT ?? 3000;

const server = createServer((req, res) => {{
  if (req.url === '/health') {{
    res.writeHead(200, {{ 'content-type': 'application/json' }});
    res.end(JSON.stringify({{ status: 'ok', service: '{name}' }}));
    return;
  }}
  res.writeHead(404, {{ 'content-type': 'application/json' }});
  res.end(JSON.stringify({{ error: 'not found' }}));
}});

server.listen(port, () => console.log(`listening on :${{port}}`));

export default server;
""",
        "README.md": f"# {name}\n\n{description}\n\n```bash\nnpm start\n```\n",
    }


_SCAFFOLDS = {
    "static-site": _static_site,
    "python-cli": _python_cli,
    "python-api": _python_api,
    "node-api": _node_api,
}


def tools() -> list[Tool]:
    return [RunPython(), RunTests(), AnalyzeCode(), FormatCode(), ProjectScaffold()]


__all__ = ["tools"]
