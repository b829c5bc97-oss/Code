"""
System monitor — Phase 8.

Real, lightweight system info via `psutil` — CPU/RAM/disk/battery/network/
running processes. Cheap enough to poll every few seconds from the UI
(`GET /api/system` in `main.py`) as well as being callable as a tool so
JARVIS can answer "how's my computer doing?" directly.
"""
from __future__ import annotations

from backend.core.permissions import PermissionLevel
from backend.tools.registry import Tool, ToolRegistry, ToolResult


def get_system_info() -> dict:
    import psutil

    battery = None
    try:
        sensor = psutil.sensors_battery()
        if sensor is not None:
            battery = {"percent": round(sensor.percent, 1), "plugged_in": sensor.power_plugged}
    except Exception:  # noqa: BLE001 - not available on all platforms
        battery = None

    net_ok = any(getattr(stats, "isup", False) for stats in psutil.net_if_stats().values())

    top_processes = sorted(
        (
            {"name": p.info.get("name"), "memory_percent": round(p.info.get("memory_percent") or 0, 1)}
            for p in psutil.process_iter(["name", "memory_percent"])
            if p.info.get("name")
        ),
        key=lambda p: p["memory_percent"],
        reverse=True,
    )[:8]

    return {
        "cpu_percent": psutil.cpu_percent(interval=0.2),
        "memory_percent": psutil.virtual_memory().percent,
        "disk_percent": psutil.disk_usage("/").percent,
        "battery": battery,
        "network_up": net_ok,
        "top_processes": top_processes,
    }


def register_system_tools(registry: ToolRegistry) -> None:
    async def system_info(**_: object) -> ToolResult:
        try:
            info = get_system_info()
        except Exception as exc:  # noqa: BLE001
            return ToolResult(success=False, error=f"Couldn't read system info: {exc}")
        summary = (
            f"CPU {info['cpu_percent']}%, memory {info['memory_percent']}%, "
            f"disk {info['disk_percent']}%, network "
            f"{'up' if info['network_up'] else 'down'}"
        )
        if info["battery"]:
            summary += f", battery {info['battery']['percent']}%"
        return ToolResult(success=True, output=summary)

    registry.register(
        Tool(
            name="system.get_system_info",
            description="Get current CPU, memory, disk, battery, and network status.",
            parameters={"type": "object", "properties": {}},
            permission=PermissionLevel.LOW,
            execute=system_info,
        )
    )
