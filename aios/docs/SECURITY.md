# Security model

## Threat model

AIOS runs with a user's real filesystem, shell, network and credentials, driven
by a language model that can be wrong, and by instructions that may be
influenced by content it reads. The design assumes:

1. **The model will occasionally propose something destructive** — not
   maliciously, just from a misread goal or a hallucinated path.
2. **Content the agent reads is untrusted.** A web page, a README or a CI log
   can contain text engineered to redirect the agent (prompt injection).
3. **Tools will have bugs**, including third-party plugin tools.
4. **The user is not watching.** Long runs are the point; a control that only
   works when someone is reading the screen is not a control.

So no single mechanism is trusted. Authority is constrained structurally, and
the constraints hold whether or not the model cooperates.

## What is guaranteed

### Filesystem containment

`PathJail` confines access to the workspace. It defends the four ways sandboxes
usually leak:

| Attack | Defence |
|---|---|
| `../../etc/passwd` | resolved and normalised before the containment check |
| symlink inside → outside | symlinks resolved *before* checking, not after |
| path that doesn't exist yet | resolved with `strict=False`; still checked |
| `/work` vs `/work-secrets` | containment compared by path *parts*, not string prefix |

`/etc`, `/bin`, `/usr`, `/boot`, `/dev`, `/proc`, `/sys` and `/var/lib` are
never writable, even if the workspace nominally contains them.

Escaping requires the `fs.outside_workspace` capability, which is not in any
default grant.

### Capability grants

Every tool declares the capabilities it needs. A session holds a set. The policy
engine refuses anything exceeding it — *before* the tool's code runs.

This is what makes plugins safe. A plugin tool that never declared `shell.exec`
cannot spawn a process, regardless of what its `execute()` body attempts,
because the refusal happens at the invocation boundary.

Default grant (`CapabilitySet.standard()`):

| Granted | Withheld |
|---|---|
| `fs.read` `fs.write` `fs.delete` | `publish` |
| `shell.exec` `process.spawn` | `comm.send` |
| `net.read` `net.write` `net.browser` | `financial` |
| `model.call` | `credentials` `system.config` `fs.outside_workspace` |

Withheld capabilities are opt-in per run (`--allow publish`) — and even once
granted, `rule_outward_facing` still requires approval in **every** security
mode. Granting is not the same as auto-approving.

### Policy verdicts

Ordered, pure rules produce one of three verdicts:

- **`ALLOW`** — proceed silently
- **`CONFIRM`** — proceed only after an approval decision
- **`DENY`** — never proceed, regardless of approval

`DENY` is final. There is no approval prompt for `rm -rf /`, `dd of=/dev/sda`,
`chmod -R 777 /` or a fork bomb — these are refusals, not warnings.

The rule that produced a verdict is recorded in the ledger, so any decision can
be traced to the line of policy that made it.

### Command analysis

Shell commands are statically analysed before execution. The analysis is
deliberately conservative: it decides whether to *ask*, not whether the command
is truly dangerous. A false positive costs one confirmation; a false negative
costs a user's data.

Flagged: recursive deletes, `sudo`/`su`, force pushes, `git reset --hard`,
`git clean -fdx`, history rewrites, disk utilities, `curl … | sh`,
shutdown/reboot, permission changes on `/`.

### Approval brokering

Approvals are scoped so a long run asks once per class rather than per call:
`ONCE`, `TOOL` (rest of this run), `ALWAYS`, `NEVER` (abort).

`approval_mode = "prompt"` with no interactive terminal resolves to **deny**,
never to a silent yes. `--yes` switches to auto-approve and is an explicit,
logged choice for unattended runs; it does not bypass `DENY`.

The web interface (`aios serve`) uses its own broker, `WebApprover`, and does
not read `security.approval_mode` at all — a browser session always requires
a real click. A `CONFIRM` decision sends an `approval_request` over the
WebSocket and blocks that step until the matching `approval_response`
arrives; a tab that never answers times out to a denial, and a tab that
disconnects mid-approval resolves every pending request as denied. There is
no configuration path to make the website auto-approve.

### Secret handling

Redaction runs on every record leaving the process: logs, ledger entries,
events, reports and memory writes. It matches known credential shapes
(Anthropic, OpenAI, GitHub, Slack, Google, AWS, JWTs, PEM blocks, bearer
tokens, URL credentials) plus a conservative `name=value` pattern for anything
whose key looks sensitive.

- Redacted values keep a short fingerprint (`[REDACTED:github_token:ghp…a1b2]`)
  so operators can correlate occurrences without recovering the value.
- Placeholders (`${MY_KEY}`, `<your-token>`) are left alone.
- **Memory refuses secrets outright** rather than masking them, so a credential
  cannot survive as a "helpful" remembered fact.

Subprocesses receive a scrubbed environment: credential-shaped variables are
stripped, with an explicit allowlist (`PATH`, `HOME`, `LANG`, …) for what a
build actually needs.

### Network safety

`net.http`, `net.read_page` and `net.download` refuse hosts resolving to
loopback, link-local, private or reserved ranges — the SSRF guard that stops
"summarise this URL" from reading cloud instance metadata. `169.254.169.254` is
blocked by default. Redirects are followed manually so **every hop** is
re-checked; an allowlisted host cannot bounce a request to a blocked one.

Overriding requires putting the host in `security.allowed_hosts` deliberately.

### Reversibility

`fs.delete` moves to a run-scoped trash directory and reports the recovery path.
Permanent removal requires `purge: true`, which raises the action to `CRITICAL`
and always requires approval.

`git.checkpoint` snapshots the working tree before risky work, so recovery can
roll back an edit instead of reasoning its way out of it.

### Resource ceilings

Hard limits on wall-clock, steps, tool calls, model calls, tokens and dollars,
checked before each consuming action. A soft warning fires at 80%. An agent with
a retry loop and a planner is structurally an infinite money sink; the budget is
what makes it safe to walk away from.

## What is *not* guaranteed

Stated plainly, because a security document that only lists strengths is
marketing.

- **Not a hardened sandbox.** Tools run in the same process and OS user as the
  kernel. The jail defends against mistakes and against a confused model — not
  against a deliberately malicious plugin with `shell.exec`. For untrusted
  plugins, run the whole OS in a container.
- **Prompt injection is mitigated, not solved.** Content read from the web
  cannot escalate capabilities or escape the jail, and it cannot approve its own
  actions. But it *can* influence what the planner proposes within the granted
  set. Keep the grant narrow; read the plan (`aios plan`) for sensitive work.
- **No multi-tenant isolation.** One workspace, one user. Memory and the
  artifact store are not partitioned by principal.
- **Model output is not trusted, but tool output is.** A compromised tool can
  return anything, and the verifier will believe its structured result — which
  is why verification checks the *filesystem*, not the tool's self-report,
  wherever it can.

## Reporting

Security issues: open a GitHub issue marked `security` with reproduction steps.
Please don't include real credentials in the report — a fingerprint from the
redacted logs is enough to correlate.
