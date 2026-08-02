"""Command line interface.

A thin adapter over the kernel: parse arguments, wire a console renderer onto
the event bus, invoke, print. All the intelligence lives below this layer,
which is exactly why a second interface (HTTP, chat, editor plugin) costs so
little to add.

Exit codes are meaningful, because this runs in CI and cron:

    0  succeeded
    1  partial success - some deliverables produced
    2  failed
    3  cancelled or interrupted
    4  usage or configuration error
"""

from __future__ import annotations

import argparse
import asyncio
import json
import signal
import sys
from pathlib import Path
from typing import Any

from ..foundation.config import Config
from ..foundation.errors import AiosError
from ..foundation.logging import configure, get_logger
from ..kernel.kernel import Kernel
from ..plugins.loader import PluginLoader
from ..runtime.events import EventBus
from ..security.approvals import AutoApprove, build_broker
from ..security.capabilities import ALL_CAPABILITIES, CapabilitySet
from ..tools import default_registry
from . import report as report_module
from .console import ConsoleRenderer

log = get_logger("cli")

EXIT_OK, EXIT_PARTIAL, EXIT_FAILED, EXIT_CANCELLED, EXIT_USAGE = 0, 1, 2, 3, 4


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="aios",
        description="AI Digital Operating System — describe a goal, get finished work.",
    )
    parser.add_argument("--config", help="path to aios.toml")
    parser.add_argument("--workspace", "-w", default=".", help="workspace root (the sandbox jail)")
    parser.add_argument("--log-level", default="", help="DEBUG, INFO, WARNING, ERROR")
    parser.add_argument("--json-logs", action="store_true", help="emit machine-readable logs")
    sub = parser.add_subparsers(dest="command", required=True)

    run = sub.add_parser("run", help="understand, plan and execute a goal")
    run.add_argument("goal", nargs="+", help="what you want done, in plain language")
    run.add_argument("--dry-run", action="store_true", help="plan and simulate, change nothing")
    run.add_argument("--yes", "-y", action="store_true",
                     help="auto-approve gated actions (unattended runs)")
    run.add_argument("--max-parallel", type=int, help="concurrent steps")
    run.add_argument("--budget-usd", type=float, help="hard spend ceiling for this run")
    run.add_argument("--time-limit", type=float, help="wall-clock ceiling in seconds")
    run.add_argument("--security", choices=["strict", "standard", "permissive"])
    run.add_argument("--allow", action="append", default=[],
                     help="grant a capability, e.g. --allow publish (repeatable)")
    run.add_argument("--report", metavar="DIR", help="write markdown/HTML/JSON reports here")
    run.add_argument("--verbose", "-v", action="store_true")
    run.add_argument("--json", action="store_true", help="print the result as JSON")

    plan = sub.add_parser("plan", help="show the plan without executing it")
    plan.add_argument("goal", nargs="+")
    plan.add_argument("--json", action="store_true")

    tools = sub.add_parser("tools", help="list available tools")
    tools.add_argument("--tag", help="filter by tag")
    tools.add_argument("--json", action="store_true")

    sub.add_parser("doctor", help="check the environment and report what is missing")

    memory = sub.add_parser("memory", help="inspect persistent memory")
    memory.add_argument("action", choices=["list", "recall", "add", "forget", "stats"])
    memory.add_argument("value", nargs="*", help="query, content, or memory id")
    memory.add_argument("--kind", default="preference", help="for `add`")

    runs = sub.add_parser("runs", help="list previous runs")
    runs.add_argument("--limit", type=int, default=20)

    replay = sub.add_parser("replay", help="summarise a past run from its ledger")
    replay.add_argument("run_id")

    return parser


def _config_for(args: argparse.Namespace) -> Config:
    overrides: dict[str, Any] = {"workspace": {"root": args.workspace}}
    if getattr(args, "log_level", ""):
        overrides["log_level"] = args.log_level
    execution: dict[str, Any] = {}
    if getattr(args, "max_parallel", None):
        execution["max_parallel"] = args.max_parallel
    if execution:
        overrides["execution"] = execution
    budget: dict[str, Any] = {}
    if getattr(args, "budget_usd", None) is not None:
        budget["max_usd"] = args.budget_usd
    if getattr(args, "time_limit", None) is not None:
        budget["wall_clock_seconds"] = args.time_limit
    if budget:
        overrides["budget"] = budget
    security: dict[str, Any] = {}
    if getattr(args, "security", None):
        security["mode"] = args.security
    if getattr(args, "yes", False):
        security["approval_mode"] = "auto"
    if security:
        overrides["security"] = security
    return Config.load(args.config, overrides=overrides)


def _grant_for(args: argparse.Namespace) -> CapabilitySet:
    grant = CapabilitySet.standard()
    for name in getattr(args, "allow", []) or []:
        if name == "all":
            return CapabilitySet.all()
        if name not in ALL_CAPABILITIES:
            matches = [c for c in ALL_CAPABILITIES if c.startswith(name)]
            if not matches:
                raise AiosError(
                    f"unknown capability {name!r}; known: {', '.join(sorted(ALL_CAPABILITIES))}"
                )
            grant = grant.with_(*matches)
            continue
        grant = grant.with_(name)
    return grant


def _build_kernel(args: argparse.Namespace, config: Config, bus: EventBus) -> Kernel:
    registry = default_registry()
    loader = PluginLoader(registry, config)
    loader.load_all()
    approvals = AutoApprove() if getattr(args, "yes", False) else build_broker(
        config.security.approval_mode
    )
    kernel = Kernel(
        config, registry=registry, bus=bus, approvals=approvals, grant=_grant_for(args)
    )
    for rule in loader.rules:
        kernel.policy.rules.append(rule)
    return kernel


# --------------------------------------------------------------------------
# commands
# --------------------------------------------------------------------------


async def cmd_run(args: argparse.Namespace) -> int:
    config = _config_for(args)
    bus = EventBus()
    ConsoleRenderer(bus, verbose=args.verbose)
    kernel = _build_kernel(args, config, bus)

    goal = " ".join(args.goal)
    task = asyncio.ensure_future(kernel.run(goal, dry_run=args.dry_run))
    _install_signal_handlers(task)
    try:
        result = await task
    except asyncio.CancelledError:
        print("\ninterrupted", file=sys.stderr)
        return EXIT_CANCELLED
    finally:
        kernel.close()

    if args.report:
        written = report_module.write(result, args.report)
        print(f"\nreports: {written['html']}", file=sys.stderr)
    if args.json:
        print(json.dumps(result.to_dict(), indent=2, default=str))
    else:
        print("\n" + result.summary)

    return {
        "succeeded": EXIT_OK, "partial": EXIT_PARTIAL,
        "cancelled": EXIT_CANCELLED,
    }.get(result.status, EXIT_FAILED)


async def cmd_plan(args: argparse.Namespace) -> int:
    config = _config_for(args)
    bus = EventBus()
    kernel = _build_kernel(args, config, bus)
    goal = " ".join(args.goal)
    try:
        intent = await kernel.intent_resolver.resolve(goal)
        plan = await kernel.planner.plan(intent, kernel.grant)
        plan.normalize().validate()
    finally:
        kernel.close()

    if args.json:
        print(json.dumps(
            {"intent": intent.to_dict(), "plan": plan.to_dict(include_state=False)},
            indent=2, default=str,
        ))
    else:
        print(intent.render())
        print()
        print(plan.render())
        errors = kernel.planner.ground(plan, kernel.grant)
        print("\ngrounding: " + ("ok" if not errors else "; ".join(errors[:5])))
    return EXIT_OK


async def cmd_tools(args: argparse.Namespace) -> int:
    # Load plugins too: `aios tools` must show the same registry a run uses,
    # otherwise it quietly under-reports what the OS can actually do.
    registry = default_registry()
    PluginLoader(registry, _config_for(args)).load_all()
    tools = registry.by_tag(args.tag) if args.tag else registry.all()
    if args.json:
        print(json.dumps([t.manifest() for t in tools], indent=2))
        return EXIT_OK
    print(f"{len(tools)} tool(s)\n")
    for tool in tools:
        print(f"  {tool.name:<22} {tool.risk.name:<9} {tool.summary}")
        if tool.tags:
            print(f"  {'':<22} {'':<9} tags: {', '.join(tool.tags)}")
    return EXIT_OK


async def cmd_doctor(args: argparse.Namespace) -> int:
    import shutil

    config = _config_for(args)
    registry = default_registry()
    loader = PluginLoader(registry, config)
    plugins = loader.load_all()
    from ..model import build_providers

    checks: list[tuple[str, bool, str]] = []
    checks.append(("workspace writable", _writable(config.workspace_root), str(config.workspace_root)))
    for provider in build_providers(config.model):
        checks.append((f"model provider: {provider.name}", provider.available(),
                       "ready" if provider.available() else "no credentials"))
    for binary, why in (
        ("git", "version control tools"),
        ("ffmpeg", "video and audio tools"),
        ("ffprobe", "media inspection"),
        ("node", "javascript projects"),
    ):
        path = shutil.which(binary)
        checks.append((f"binary: {binary}", bool(path), path or f"missing — {why} unavailable"))
    try:
        import playwright  # noqa: F401

        checks.append(("playwright", True, "browser automation ready"))
    except ImportError:
        checks.append(("playwright", False, "missing — install aios[browser] for browser tools"))

    checks.append(("tools registered", len(registry) > 0, f"{len(registry)} tools"))
    for plugin in plugins:
        checks.append((
            f"plugin: {plugin.name}",
            plugin.ok,
            f"{len(plugin.tools)} tool(s), {plugin.rules} rule(s)" if plugin.ok else plugin.error,
        ))

    width = max(len(name) for name, _, _ in checks)
    failures = 0
    for name, ok, detail in checks:
        mark = "✔" if ok else "✘"
        if not ok:
            failures += 1
        print(f"  {mark} {name:<{width}}  {detail}")
    print(f"\n{len(checks) - failures}/{len(checks)} checks passed")
    return EXIT_OK


def _writable(path: Path) -> bool:
    try:
        path.mkdir(parents=True, exist_ok=True)
        probe = path / ".aios-write-probe"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()
    except OSError:
        return False
    return True


async def cmd_memory(args: argparse.Namespace) -> int:
    from ..memory.store import MemoryStore

    config = _config_for(args)
    config.ensure_dirs()
    store = MemoryStore(config.memory_db, config.memory)
    scope = str(config.workspace_root)
    try:
        if args.action == "stats":
            print(json.dumps(store.stats(), indent=2))
        elif args.action == "list":
            for memory in store.preferences(scope):
                print(f"  [{memory.kind}] {memory.id}  {memory.content}")
        elif args.action == "recall":
            query = " ".join(args.value)
            if not query:
                print("usage: aios memory recall <query>", file=sys.stderr)
                return EXIT_USAGE
            for memory in store.recall(query, scope=scope):
                print(f"  {memory.score:.3f} [{memory.kind}] {memory.content}")
        elif args.action == "add":
            content = " ".join(args.value)
            if not content:
                print("usage: aios memory add <text>", file=sys.stderr)
                return EXIT_USAGE
            memory = store.remember(args.kind, content, scope=scope, importance=0.8)
            print(f"  stored {memory.id}" if memory else "  refused (duplicate or contains secrets)")
        elif args.action == "forget":
            for memory_id in args.value:
                print(f"  {'forgot' if store.forget(memory_id) else 'not found'} {memory_id}")
    finally:
        store.close()
    return EXIT_OK


async def cmd_runs(args: argparse.Namespace) -> int:
    from ..memory.store import MemoryStore

    config = _config_for(args)
    config.ensure_dirs()
    store = MemoryStore(config.memory_db, config.memory)
    try:
        rows = store.recent_runs(args.limit)
    finally:
        store.close()
    if not rows:
        print("  no runs recorded yet")
        return EXIT_OK
    for row in rows:
        duration = (row.get("ended_at") or row["started_at"]) - row["started_at"]
        print(
            f"  {row['run_id']}  {row['status']:<10} {duration:6.1f}s  "
            f"${row.get('usd', 0):.4f}  {row['goal'][:60]}"
        )
    return EXIT_OK


async def cmd_replay(args: argparse.Namespace) -> int:
    config = _config_for(args)
    path = config.runs_dir / f"{args.run_id}.jsonl"
    if not path.exists():
        matches = sorted(config.runs_dir.glob(f"*{args.run_id}*.jsonl"))
        if not matches:
            print(f"no ledger found for {args.run_id} in {config.runs_dir}", file=sys.stderr)
            return EXIT_USAGE
        path = matches[0]
    print(json.dumps(report_module.replay_summary(path), indent=2, default=str))
    return EXIT_OK


COMMANDS = {
    "run": cmd_run,
    "plan": cmd_plan,
    "tools": cmd_tools,
    "doctor": cmd_doctor,
    "memory": cmd_memory,
    "runs": cmd_runs,
    "replay": cmd_replay,
}


def _install_signal_handlers(task: asyncio.Future[Any]) -> None:
    """First Ctrl-C cancels cleanly; the second exits hard."""
    loop = asyncio.get_running_loop()
    state = {"count": 0}

    def handler() -> None:
        state["count"] += 1
        if state["count"] == 1:
            print("\ncancelling — press Ctrl-C again to force quit", file=sys.stderr)
            task.cancel()
        else:  # pragma: no cover - hard exit path
            raise KeyboardInterrupt

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, handler)
        except (NotImplementedError, RuntimeError):  # pragma: no cover - Windows
            pass


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    configure(args.log_level or "INFO", json_output=args.json_logs or None)
    try:
        return asyncio.run(COMMANDS[args.command](args))
    except AiosError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_USAGE
    except KeyboardInterrupt:  # pragma: no cover
        return EXIT_CANCELLED


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
