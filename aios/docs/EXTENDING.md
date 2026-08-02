# Extending AIOS

Three extension points, in increasing order of scope: a tool, a model provider,
a policy rule. All three can ship in a plugin.

## Writing a tool

A tool is the only way the OS touches the world. The contract is strict on
purpose — declared authority and a typed schema are what let the policy engine
and the recovery engine reason about an invocation *before* it runs.

```python
from aios.security import capabilities as caps
from aios.security.capabilities import RiskLevel
from aios.security.policy import ActionRequest
from aios.tools.base import Tool, ToolContext, ToolResult


class SendSlackMessage(Tool):
    name = "slack.send"
    summary = "Post a message to a Slack channel."
    tags = ("chat", "notify", "publish")

    # Authority: read by the policy engine before execute() is reached.
    capabilities = frozenset({caps.NET_WRITE, caps.COMM_SEND})
    risk = RiskLevel.HIGH
    reversible = False          # a sent message cannot be unsent
    idempotent = False          # the retry loop must not repeat it blindly

    parameters = {
        "type": "object",
        "properties": {
            "channel": {"type": "string", "pattern": "^#?[a-z0-9-]+$"},
            "text": {"type": "string", "minLength": 1, "maxLength": 4000},
        },
        "required": ["channel", "text"],
        "additionalProperties": False,
    }

    def plan_action(self, args) -> ActionRequest:
        """Surface the concrete side effect so policy sees the real thing."""
        action = super().plan_action(args)
        action.urls = ["https://slack.com/api/chat.postMessage"]
        action.summary = f"post to {args.get('channel')}: {args.get('text', '')[:80]}"
        return action

    async def execute(self, args, ctx: ToolContext) -> ToolResult:
        # Arguments are already validated and coerced. Don't re-parse them.
        response = await post_to_slack(args["channel"], args["text"])
        return ToolResult.success(
            {"channel": args["channel"], "ts": response["ts"]},
            summary=f"posted to {args['channel']}",
        )
```

### Rules that matter

**Declare authority honestly.** `capabilities`, `risk` and `reversible` are the
only things standing between a user and a surprise. A tool that sends, publishes,
spends or deletes must say so. Under-declaring is a security bug.

**Override `plan_action` whenever the tool touches a path, URL or command.**
The base implementation gives the policy engine only a tool name; the jail and
host rules need the actual targets to do anything useful.

**Never write outside the jail.** Use `ctx.jail.resolve(path, write=True)`,
which raises `SandboxViolation` rather than returning a sentinel you might
forget to check.

**Return structure, not prose.** `ToolResult.output` is what later steps bind to
via `${step.field}` and what the verifier asserts on. A tool returning a
human-readable string is a dead end in the graph.

**Raise freely.** `Tool.run()` classifies every exception through the error
taxonomy. Raise `InvalidArguments` for a bad request, `TransientError` for
something worth retrying, `ToolExecutionError` otherwise — or just let a real
exception propagate and be classified.

**Respect the deadline.** `ctx.remaining_seconds()` is the smaller of the step
timeout and the run's remaining wall-clock budget. Size subprocess timeouts from
it so a tool never outlives its budget.

**Register artifacts.** `ctx.keep_file(path)` / `ctx.keep_text(name, text)` puts
a deliverable in the content-addressed store with provenance, so it appears in
the report and later steps can reference it.

**Add a `dry_run`** if the default (describe the arguments) is not informative.

### Testing it

```python
async def test_slack_send(tool_context):
    tool = SendSlackMessage()
    result = await tool.run({"channel": "#general", "text": "hi"}, tool_context)
    assert result.ok

def test_it_declares_its_authority():
    tool = SendSlackMessage()
    assert caps.COMM_SEND in tool.capabilities   # so policy always gates it
    assert not tool.reversible
```

The `tool_context` fixture in `tests/conftest.py` gives a jailed temp workspace,
an artifact store, an event bus and a manual clock.

---

## Writing a model provider

Providers do one thing: `ModelRequest → Completion`, translating vendor errors
into the shared taxonomy. Retries, caching, failover and budget accounting are
`ModelClient`'s job — do not reimplement them.

```python
from aios.foundation.errors import ProviderUnavailable, RateLimited
from aios.model.provider import BaseProvider
from aios.model.types import Completion, ModelRequest
from aios.runtime.budget import Usage


class MyProvider(BaseProvider):
    name = "myprovider"
    supports_tools = True
    supports_json_mode = True
    generative = True          # False only for extractive fallbacks
    default_model = "my-model-v2"

    def available(self) -> bool:
        return bool(self.api_key)

    async def complete(self, request: ModelRequest) -> Completion:
        try:
            raw = await self._call(self._encode(request))
        except HTTPError as exc:
            if exc.status == 429:
                raise RateLimited("rate limited", retry_after=exc.retry_after) from exc
            if exc.status >= 500:
                raise ProviderUnavailable(f"upstream {exc.status}") from exc
            raise
        return Completion(
            text=raw["text"],
            usage=Usage(raw["in_tokens"], raw["out_tokens"]),
            model=raw["model"],
        )
```

Map errors precisely: `RateLimited` and `ProviderUnavailable` are retryable and
trigger failover; anything else fails fast. Getting this wrong means either
hammering a broken endpoint or giving up on a recoverable blip.

Register it, then select it with `model.provider = "myprovider"`:

```python
from aios.model import register_provider
register_provider("myprovider", MyProvider)
```

Add pricing to `aios/runtime/budget.py::PRICING` so cost accounting is real
rather than zero.

---

## Writing a policy rule

Rules are pure functions of `(engine, request)` returning a `Decision` or
`None`. `DENY` from any rule is final.

```python
from aios.security.policy import Decision, Verdict

def no_production_writes(engine, request):
    """Refuse any write whose path mentions production."""
    if any("/prod/" in p for p in request.paths) and not request.reversible:
        return Decision(
            Verdict.DENY, "no_production_writes",
            "irreversible writes under /prod/ are refused by house policy",
        )
    return None


def policy_rules():
    return [no_production_writes]
```

Rules run in order and `evaluate` returns the first `DENY`, or the first
`CONFIRM` if nothing denied. Keep them pure — the verdict is recorded in the
ledger with the rule name, and a rule with side effects makes that record a lie.

---

## Packaging a plugin

A plugin is a Python module exposing any of `tools()`, `providers()`,
`policy_rules()` or `setup(registry, config)`.

```python
# ~/.aios/plugins/slack.py
def tools():
    return [SendSlackMessage()]

def policy_rules():
    return [no_production_writes]
```

Load it from a directory:

```toml
# aios.toml
plugin_paths = ["~/.aios/plugins"]
```

or ship it as an installed package:

```toml
# your plugin's pyproject.toml
[project.entry-points."aios.plugins"]
slack = "my_package.aios_plugin"
```

Two properties are guaranteed. A plugin that raises on import is logged and
skipped — it can never prevent the OS from booting. And plugin tools go through
the same policy engine as builtins, so installing one never widens what a
session may do; the user still has to grant the capability.

Run `aios tools --json` to confirm yours registered with the authority you
expect.
