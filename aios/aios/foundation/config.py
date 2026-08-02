"""Layered configuration.

Precedence, lowest to highest::

    dataclass defaults  <  aios.toml  <  AIOS_* environment  <  explicit overrides

Everything the kernel can be tuned with lives here, so a deployment is one file
plus environment, and a test is one ``Config(...)`` construction.
"""

from __future__ import annotations

import os
import tomllib
from dataclasses import asdict, dataclass, field, fields, is_dataclass
from pathlib import Path
from typing import Any

from .errors import ConfigError

CONFIG_FILENAMES = ("aios.toml", ".aios.toml")


@dataclass(slots=True)
class WorkspaceConfig:
    """Where the OS is allowed to read and write.

    ``root`` is the sandbox jail: no builtin tool may escape it without an
    explicit capability grant.
    """

    root: str = "."
    state_dirname: str = ".aios"
    keep_runs: int = 200


@dataclass(slots=True)
class ModelConfig:
    provider: str = "auto"  # auto | anthropic | deterministic | echo
    model: str = "claude-sonnet-5"
    planner_model: str = ""  # falls back to `model`
    fast_model: str = "claude-haiku-4-5-20251001"
    temperature: float = 0.2
    max_tokens: int = 8192
    timeout_seconds: float = 120.0
    max_retries: int = 3
    cache_enabled: bool = True


@dataclass(slots=True)
class ExecutionConfig:
    max_parallel: int = 4
    step_timeout_seconds: float = 900.0
    max_attempts: int = 3
    backoff_base_seconds: float = 1.0
    backoff_max_seconds: float = 60.0
    backoff_jitter: float = 0.25
    replan_limit: int = 2
    verify: bool = True
    continue_on_optional_failure: bool = True


@dataclass(slots=True)
class SecurityConfig:
    """``mode`` sets the default posture; the policy engine refines per action.

    strict      every side effect needs approval
    standard    writes inside the workspace are free, everything else is gated
    permissive  network + workspace writes free, destructive actions gated
    """

    mode: str = "standard"
    allow_network: bool = True
    allowed_hosts: list[str] = field(default_factory=list)  # empty = any
    blocked_hosts: list[str] = field(default_factory=lambda: ["169.254.169.254"])
    allow_shell: bool = True
    shell_denylist: list[str] = field(
        default_factory=lambda: [
            "mkfs", "shutdown", "reboot", "halt", "poweroff", "init",
            "dd", "fdisk", "parted", "chown -R /", "chmod -R 777 /",
        ]
    )
    approval_mode: str = "prompt"  # prompt | auto | deny
    subprocess_env_allowlist: list[str] = field(
        default_factory=lambda: ["PATH", "HOME", "LANG", "LC_ALL", "TZ", "TERM", "TMPDIR"]
    )
    max_output_bytes: int = 2_000_000


@dataclass(slots=True)
class BudgetConfig:
    wall_clock_seconds: float = 3600.0
    max_steps: int = 200
    max_tool_calls: int = 500
    max_model_calls: int = 200
    max_tokens: int = 2_000_000
    max_usd: float = 25.0


@dataclass(slots=True)
class MemoryConfig:
    enabled: bool = True
    db_filename: str = "memory.db"
    max_recall: int = 12
    persist_secrets: bool = False  # hard off by default; see memory.store


@dataclass(slots=True)
class Config:
    workspace: WorkspaceConfig = field(default_factory=WorkspaceConfig)
    model: ModelConfig = field(default_factory=ModelConfig)
    execution: ExecutionConfig = field(default_factory=ExecutionConfig)
    security: SecurityConfig = field(default_factory=SecurityConfig)
    budget: BudgetConfig = field(default_factory=BudgetConfig)
    memory: MemoryConfig = field(default_factory=MemoryConfig)
    log_level: str = "INFO"
    plugin_paths: list[str] = field(default_factory=list)

    # -- derived paths ---------------------------------------------------
    @property
    def workspace_root(self) -> Path:
        return Path(self.workspace.root).expanduser().resolve()

    @property
    def state_dir(self) -> Path:
        return self.workspace_root / self.workspace.state_dirname

    @property
    def runs_dir(self) -> Path:
        return self.state_dir / "runs"

    @property
    def blobs_dir(self) -> Path:
        return self.state_dir / "blobs"

    @property
    def memory_db(self) -> Path:
        return self.state_dir / self.memory.db_filename

    def ensure_dirs(self) -> None:
        for path in (self.state_dir, self.runs_dir, self.blobs_dir):
            path.mkdir(parents=True, exist_ok=True)

    # -- loading ---------------------------------------------------------
    @classmethod
    def load(
        cls,
        path: str | Path | None = None,
        *,
        env: dict[str, str] | None = None,
        overrides: dict[str, Any] | None = None,
    ) -> Config:
        env = os.environ if env is None else env
        data: dict[str, Any] = {}

        config_path = _resolve_config_path(path, env)
        if config_path is not None:
            try:
                data = tomllib.loads(config_path.read_text("utf-8"))
            except (OSError, tomllib.TOMLDecodeError) as exc:
                raise ConfigError(f"cannot read config {config_path}: {exc}", cause=exc) from exc
            data.pop("tool", None)

        _deep_merge(data, _env_overrides(env))
        if overrides:
            _deep_merge(data, overrides)

        cfg = _build(cls, data, "config")
        cfg.validate()
        return cfg

    def validate(self) -> None:
        if self.execution.max_parallel < 1:
            raise ConfigError("execution.max_parallel must be >= 1")
        if self.execution.max_attempts < 1:
            raise ConfigError("execution.max_attempts must be >= 1")
        if self.security.mode not in {"strict", "standard", "permissive"}:
            raise ConfigError(f"unknown security.mode {self.security.mode!r}")
        if self.security.approval_mode not in {"prompt", "auto", "deny"}:
            raise ConfigError(f"unknown security.approval_mode {self.security.approval_mode!r}")
        if self.model.temperature < 0 or self.model.temperature > 2:
            raise ConfigError("model.temperature must be within [0, 2]")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _resolve_config_path(path: str | Path | None, env: dict[str, str]) -> Path | None:
    if path:
        candidate = Path(path).expanduser()
        if not candidate.is_file():
            raise ConfigError(f"config file not found: {candidate}")
        return candidate
    if env.get("AIOS_CONFIG"):
        candidate = Path(env["AIOS_CONFIG"]).expanduser()
        if not candidate.is_file():
            raise ConfigError(f"AIOS_CONFIG points at a missing file: {candidate}")
        return candidate
    here = Path.cwd()
    for directory in (here, *here.parents):
        for name in CONFIG_FILENAMES:
            candidate = directory / name
            if candidate.is_file():
                return candidate
    return None


# AIOS_MODEL_PROVIDER -> {"model": {"provider": ...}}
def _env_overrides(env: dict[str, str]) -> dict[str, Any]:
    sections = set(_SECTIONS)
    out: dict[str, Any] = {}
    for raw_key, raw_value in env.items():
        if not raw_key.startswith("AIOS_"):
            continue
        body = raw_key[5:].lower()
        section, _, rest = body.partition("_")
        if section in sections and rest:
            out.setdefault(section, {})[rest] = raw_value
        else:
            out[body] = raw_value
    return out


_SECTIONS = {"workspace", "model", "execution", "security", "budget", "memory"}


def _deep_merge(base: dict[str, Any], extra: dict[str, Any]) -> dict[str, Any]:
    for key, value in extra.items():
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            _deep_merge(base[key], value)
        else:
            base[key] = value
    return base


_HINT_CACHE: dict[type, dict[str, Any]] = {}


def _hints(cls: type) -> dict[str, Any]:
    """Resolved annotations.

    ``from __future__ import annotations`` makes ``Field.type`` a string, so the
    dataclass-vs-scalar decision below has to resolve them for real. Cached
    because config is built on every process start.
    """
    if cls not in _HINT_CACHE:
        from typing import get_type_hints

        _HINT_CACHE[cls] = get_type_hints(cls)
    return _HINT_CACHE[cls]


def _build(cls: type, data: dict[str, Any], where: str) -> Any:
    kwargs: dict[str, Any] = {}
    known = {f.name for f in fields(cls)}
    hints = _hints(cls)
    for key, value in data.items():
        if key not in known:
            raise ConfigError(
                f"unknown option {where}.{key}",
                context={"known": sorted(known)},
            )
        kwargs[key] = _coerce(hints.get(key, str), value, f"{where}.{key}")
    return cls(**kwargs)


def _coerce(annotation: Any, value: Any, where: str) -> Any:
    if is_dataclass(annotation):
        if not isinstance(value, dict):
            raise ConfigError(f"{where} must be a table")
        return _build(annotation, value, where)
    origin = getattr(annotation, "__origin__", None)
    if origin is list:
        text = "list"
    elif isinstance(annotation, str):
        text = annotation
    else:
        text = getattr(annotation, "__name__", "")
    try:
        if text.startswith("list"):
            if isinstance(value, str):
                return [item.strip() for item in value.split(",") if item.strip()]
            if not isinstance(value, list):
                raise ConfigError(f"{where} must be a list")
            return list(value)
        if text == "bool":
            if isinstance(value, bool):
                return value
            return str(value).strip().lower() in {"1", "true", "yes", "on"}
        if text == "int":
            return int(value)
        if text == "float":
            return float(value)
        if text == "str":
            return str(value)
    except (TypeError, ValueError) as exc:
        raise ConfigError(f"{where}: cannot read {value!r} as {text}") from exc
    return value
