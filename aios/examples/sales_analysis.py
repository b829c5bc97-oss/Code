#!/usr/bin/env python3
"""Hand-written plan: four independent SQL queries in parallel, then a report.

Demonstrates the pieces that matter without needing an API key:

- a DAG where three queries fan out and one report step joins them;
- ``${binding.field}`` references carrying real result rows between steps;
- verification contracts that assert on the filesystem, not on tool self-report;
- a live console fed purely by event-bus subscriptions.

    python3 examples/sales_analysis.py
"""

from __future__ import annotations

import asyncio
import csv
import random
import sys
import tempfile
from pathlib import Path

from aios import Config, Kernel
from aios.cognition.plan import Check, Plan, Step
from aios.interfaces.console import ConsoleRenderer
from aios.runtime.events import EventBus
from aios.security.approvals import AutoApprove


def make_dataset(path: Path, rows: int = 5000) -> None:
    random.seed(7)
    regions = ["north", "south", "east", "west"]
    reps = ["ana", "bo", "cy", "dee", "eli"]
    with path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh)
        writer.writerow(["date", "region", "rep", "units", "amount"])
        for _ in range(rows):
            writer.writerow([
                f"2025-{random.randint(1, 12):02d}-{random.randint(1, 28):02d}",
                random.choice(regions),
                random.choice(reps),
                random.randint(1, 40),
                round(random.uniform(50, 5000), 2),
            ])


def build_plan() -> Plan:
    query = {"sources": {"s": "sales.csv"}}
    return Plan(
        goal="analyse regional sales performance and publish a report",
        strategy="Profile the data, fan out three independent aggregations, join into one report.",
        steps=[
            Step(
                name="Profile the dataset", tool="data.inspect", binding="profile",
                arguments={"path": "sales.csv"},
                verify=[Check("no_error")],
            ),
            Step(
                name="Revenue by region", tool="data.query", binding="by_region",
                arguments={**query,
                           "sql": "SELECT region, COUNT(*) AS orders, "
                                  "ROUND(SUM(CAST(amount AS REAL)), 2) AS revenue "
                                  "FROM s GROUP BY region ORDER BY revenue DESC",
                           "output_csv": "by_region.csv"},
                verify=[Check("file_exists", "by_region.csv"),
                        Check("file_contains", "by_region.csv", expect="region")],
            ),
            Step(
                name="Top performers", tool="data.query", binding="by_rep",
                arguments={**query,
                           "sql": "SELECT rep, ROUND(SUM(CAST(amount AS REAL)), 2) AS revenue, "
                                  "SUM(CAST(units AS INTEGER)) AS units "
                                  "FROM s GROUP BY rep ORDER BY revenue DESC LIMIT 5"},
                verify=[Check("no_error")],
            ),
            Step(
                name="Monthly trend", tool="data.query", binding="trend",
                arguments={**query,
                           "sql": "SELECT substr(date, 1, 7) AS month, "
                                  "ROUND(SUM(CAST(amount AS REAL)), 2) AS revenue "
                                  "FROM s GROUP BY month ORDER BY month"},
                verify=[Check("no_error")],
            ),
            Step(
                name="Publish the report", tool="doc.report", binding="report",
                depends_on=["by_region", "by_rep", "trend"],
                arguments={
                    "output": "sales-report.html",
                    "title": "Regional Sales Analysis",
                    "summary": "Automated analysis of ${profile.rows_sampled} sales records.",
                    "sections": [
                        {"heading": "Revenue by region", "table": "${by_region.rows}"},
                        {"heading": "Top performers", "table": "${by_rep.rows}"},
                        {"heading": "Monthly trend", "table": "${trend.rows}"},
                    ],
                },
                verify=[Check("file_exists", "sales-report.html"),
                        Check("file_contains", "sales-report.html", expect="Revenue by region")],
            ),
        ],
    )


async def main() -> int:
    workspace = Path(tempfile.mkdtemp(prefix="aios-example-"))
    make_dataset(workspace / "sales.csv")
    print(f"workspace: {workspace}\n")

    config = Config.load(
        overrides={"workspace": {"root": str(workspace)},
                   "execution": {"max_parallel": 4},
                   "memory": {"enabled": False}},
        env={},
    )
    bus = EventBus()
    ConsoleRenderer(bus, stream=sys.stdout)
    kernel = Kernel(config, bus=bus, approvals=AutoApprove())

    plan = build_plan()
    result = await kernel.run(plan.goal, plan=plan)
    kernel.close()

    print(f"\nstatus:       {result.status}")
    print(f"deliverables: {[a.name for a in result.deliverables()]}")
    print(f"ledger:       {result.ledger_path}")
    print(f"\nopen {workspace / 'sales-report.html'} to see the result")
    return 0 if result.ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
