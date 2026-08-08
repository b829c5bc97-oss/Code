"""
Coding-assistant tools — Phase 7.

`code.create_project` and friends operate under `Settings.workspace_dir` —
JARVIS creates and edits project files there rather than at arbitrary paths
of its own choosing (reading/listing any path is still fine via `files.*`;
this is specifically about where JARVIS writes *new* project scaffolding).
`code.run_command` is the exception: it can run in any directory you give
it, since "run the tests for this project" only makes sense against the
project's own path — safety instead comes from permissions (MEDIUM by
default, escalated to HIGH — confirmation required — if the command looks
destructive; see `_looks_dangerous`).
"""
from __future__ import annotations

import re
import subprocess
from pathlib import Path

from backend.core.config import get_settings
from backend.core.permissions import PermissionLevel
from backend.files import file_manager
from backend.files.file_manager import FileManagerError
from backend.tools.registry import Tool, ToolRegistry, ToolResult

_TEMPLATES: dict[str, dict[str, str]] = {
    "blank": {},
    "python": {
        "main.py": "def main() -> None:\n    print(\"Hello from JARVIS!\")\n\n\nif __name__ == \"__main__\":\n    main()\n",
        "requirements.txt": "",
        "README.md": "# {name}\n\nCreated by JARVIS.\n",
    },
    "node": {
        "package.json": (
            '{{\n  "name": "{slug}",\n  "version": "0.1.0",\n  "type": "module",\n'
            '  "scripts": {{ "start": "node index.js" }}\n}}\n'
        ),
        "index.js": 'console.log("Hello from JARVIS!");\n',
        "README.md": "# {name}\n\nCreated by JARVIS.\n",
    },
}

_DANGEROUS_PATTERNS = [
    r"\brm\s+-rf\s+/(?!\S)",  # rm -rf /
    r"\bsudo\b",
    r"\bmkfs(\.|$|\s)",
    r"\bdd\s+if=",
    r":\(\)\s*\{\s*:\|:\s*&\s*\}\s*;\s*:",  # classic fork bomb
    r"\bshutdown\b",
    r"\breboot\b",
    r"\bchmod\s+-R\s+777\s+/(?!\S)",
    r">\s*/dev/sd",
    r"\bdel\s+/f\s+/s\s+/q\b",  # Windows recursive force-delete
    r"\bformat\s+[a-zA-Z]:",  # Windows drive format
]
_DANGEROUS_RE = re.compile("|".join(_DANGEROUS_PATTERNS), re.IGNORECASE)


def is_dangerous_command(command: str) -> bool:
    return bool(_DANGEROUS_RE.search(command))


def _project_dir(name: str) -> Path:
    safe_name = re.sub(r"[^\w.-]", "_", name.strip()) or "project"
    return get_settings().workspace_path / safe_name


def register_code_tools(registry: ToolRegistry) -> None:
    async def create_project(name: str, template: str = "blank", **_: object) -> ToolResult:
        template = template if template in _TEMPLATES else "blank"
        project_dir = _project_dir(name)
        if project_dir.exists():
            return ToolResult(success=False, error=f"{project_dir} already exists.")
        try:
            project_dir.mkdir(parents=True)
            for rel_path, content in _TEMPLATES[template].items():
                slug = re.sub(r"[^\w.-]", "-", name.strip().lower()) or "project"
                text = content.format(name=name, slug=slug)
                (project_dir / rel_path).write_text(text, encoding="utf-8")
        except OSError as exc:
            return ToolResult(success=False, error=f"Couldn't create project: {exc}")
        return ToolResult(
            success=True,
            output=f"Created {template} project at {project_dir}.",
        )

    async def write_file(path: str, content: str = "", **_: object) -> ToolResult:
        try:
            message = file_manager.create_file(path, content)
        except FileManagerError as exc:
            return ToolResult(success=False, error=str(exc))
        return ToolResult(success=True, output=message)

    async def read_file(path: str, **_: object) -> ToolResult:
        try:
            content = file_manager.read_file(path)
        except FileManagerError as exc:
            return ToolResult(success=False, error=str(exc))
        return ToolResult(success=True, output=content)

    async def list_files(path: str = ".", **_: object) -> ToolResult:
        try:
            entries = file_manager.list_dir(path)
        except FileManagerError as exc:
            return ToolResult(success=False, error=str(exc))
        return ToolResult(
            success=True,
            output="\n".join(e["name"] + ("/" if e["is_dir"] else "") for e in entries) or "(empty)",
        )

    async def run_command(
        command: str, cwd: str = ".", timeout: int | None = None, background: bool = False, **_: object
    ) -> ToolResult:
        settings = get_settings()
        timeout = timeout or settings.code_run_timeout_seconds
        work_dir = Path(cwd).expanduser().resolve()
        if not work_dir.exists():
            return ToolResult(success=False, error=f"{work_dir} does not exist.")

        if background:
            try:
                proc = subprocess.Popen(
                    command,
                    shell=True,
                    cwd=work_dir,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    start_new_session=True,
                )
            except OSError as exc:
                return ToolResult(success=False, error=f"Couldn't start command: {exc}")
            return ToolResult(success=True, output=f"Started in background (pid {proc.pid}): {command}")

        try:
            result = subprocess.run(
                command,
                shell=True,
                cwd=work_dir,
                timeout=timeout,
                capture_output=True,
                text=True,
            )
        except subprocess.TimeoutExpired:
            return ToolResult(success=False, error=f"Command timed out after {timeout}s: {command}")
        except OSError as exc:
            return ToolResult(success=False, error=f"Couldn't run command: {exc}")

        output = (result.stdout or "") + (result.stderr or "")
        output = output[-4000:]  # keep the tail — most relevant for errors
        if result.returncode != 0:
            return ToolResult(success=False, error=f"Exit code {result.returncode}:\n{output}")
        return ToolResult(success=True, output=output or "(no output)")

    def _escalate_run_command(arguments: dict) -> PermissionLevel | None:
        command = str(arguments.get("command", ""))
        return PermissionLevel.HIGH if is_dangerous_command(command) else None

    registry.register(
        Tool(
            name="code.create_project",
            description="Scaffold a new project (python/node/blank) in the JARVIS workspace.",
            parameters={
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "template": {"type": "string", "enum": list(_TEMPLATES), "default": "blank"},
                },
                "required": ["name"],
            },
            permission=PermissionLevel.MEDIUM,
            execute=create_project,
        )
    )
    registry.register(
        Tool(
            name="code.write_file",
            description="Write (create or overwrite) a source file with the given content.",
            parameters={
                "type": "object",
                "properties": {"path": {"type": "string"}, "content": {"type": "string"}},
                "required": ["path", "content"],
            },
            permission=PermissionLevel.MEDIUM,
            execute=write_file,
        )
    )
    registry.register(
        Tool(
            name="code.read_file",
            description="Read a source file's contents.",
            parameters={
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
            },
            permission=PermissionLevel.LOW,
            execute=read_file,
        )
    )
    registry.register(
        Tool(
            name="code.list_files",
            description="List files in a project directory.",
            parameters={"type": "object", "properties": {"path": {"type": "string", "default": "."}}},
            permission=PermissionLevel.LOW,
            execute=list_files,
        )
    )
    registry.register(
        Tool(
            name="code.run_command",
            description=(
                "Run a shell command (e.g. run tests, start a dev server, install "
                "dependencies). Commands that look destructive require confirmation "
                "regardless of the usual permission tier."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "command": {"type": "string"},
                    "cwd": {"type": "string", "default": "."},
                    "timeout": {"type": "integer"},
                    "background": {
                        "type": "boolean",
                        "default": False,
                        "description": "Run detached (e.g. a dev server) instead of waiting for it to finish.",
                    },
                },
                "required": ["command"],
            },
            permission=PermissionLevel.MEDIUM,
            execute=run_command,
            risk_escalation=_escalate_run_command,
        )
    )
