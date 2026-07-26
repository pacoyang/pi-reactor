# pi-reactor

**Scheduled and event-driven work for the [Pi coding agent](https://github.com/earendil-works/pi).**

Pi is a good coding agent, but it is *passive* — it works while you type. `pi-reactor`
gives it triggers and an outbox: a cron entry, a GitHub label, a script calling a CLI.
Work runs unattended, and the result reaches your phone.

It is an **unattended surface**, not a chat surface. Nothing here streams, steers, or
holds a conversation open — a run starts from an event, ends at a verdict, and sends one
message. When that message makes you curious, `pi-reactor resume` hands the transcript to
your own interactive Pi so you can ask the follow-up there. For live back-and-forth from
your phone, use [`pi-telegram`](https://github.com/llblab/pi-telegram); the two are
complementary and share nothing but the agent.

```
sources                       daemon                         sinks
┌ cron (built in)  ┐                                      ┌ Telegram
├ GitHub webhook   ┼──► queue ──► spawn pi --mode rpc ──►  ┤
└ CLI / scripts    ┘        budget · timeout · retry       └ Slack
                            · circuit breaker
```

## Install

```bash
npm install -g pi-reactor    # the CLI and the daemon
pi install npm:pi-reactor    # the /reactor extension and its skill, inside your Pi
```

Requires Node 22.19+ and a Pi install the daemon can spawn.

## Quick Start

```bash
pi-reactor serve       # starts with an empty configuration; you configure it next
```

That runs it in the foreground so you can watch it. Once you are past trying it out,
hand it to a service manager — see [Running as a Service](#running-as-a-service). A
schedule is only as reliable as the thing keeping the daemon alive. In another terminal:

```bash
pi-reactor doctor      # every check with a concrete fix for each failure
```

Then **just say what you want** in your interactive Pi:

> every morning at nine, summarise yesterday's commits and send it to Telegram

The extension shows a before/after of the exact configuration change, waits for your
approval, and the daemon applies it live. No restart, no file editing.

If you would rather type, the CLI drives the same daemon methods:

```bash
pi-reactor agent add report --cwd ~/projects/thing --model anthropic/claude-sonnet-5
pi-reactor sink  add tg --chat-id 123456
echo "$BOT_TOKEN" | pi-reactor secret set tg botToken   # stdin, never argv

pi-reactor trigger add nightly \
  --schedule "0 9 * * *" --timezone Asia/Shanghai \
  --agent report --task "summarise yesterday's commits" \
  --notify tg --dry-run                                 # drop --dry-run to apply
```

## Core Concepts

Three things, and every one of them is a reference the daemon validates:

| | |
|---|---|
| **agent** | a working directory plus a model — the thing that does the work |
| **sink**  | where a notification goes: Telegram, or a Slack incoming webhook |
| **trigger** | when to run, what to run, and who to tell |

A trigger names an agent and a sink, so both must exist first. Delete an agent a trigger
still points at and the daemon refuses, naming the trigger.

## The Loop

```
event ──► queue ──► gates ──► spawn ──► verdict ──► outbox ──► sink
```

**Gates run before anything is spawned**, in this order, because the cost of being wrong
grows at every step: provider credential present → working tree clean (opt-in per trigger)
→ daily budget not exhausted. A refusal costs nothing.

**Every run has a deadline.** `maxDuration` (30m by default) drives `abort` → `SIGTERM` →
`SIGKILL`, each with its own grace window. Unattended systems need an upper bound; a
runaway job would otherwise hold a slot and spend until the daily cap noticed.

**A verdict always reaches you.** The notification is committed in the same database
transaction as the run record, so once a job concludes the message *will* be delivered —
even if the agent was SIGKILLed, even if the daemon died mid-run and came back. Delivery
is at-least-once: for notifications a duplicate is noise, a loss is an outage you never
hear about.

**Failures are classified, and only some of them retry.** An agent that concludes "I
cannot do this" *succeeded* — that is a determinate answer, not something to pay for
again. Infrastructure failures (crash, provider error) retry up to three times with
jittered backoff. Policy failures (timeout, budget, config) never retry.

## Triggers

### Cron

```jsonc
{ "on": { "type": "cron", "id": "nightly", "schedule": "0 9 * * *",
          "timezone": "Asia/Shanghai", "misfirePolicy": "skip" },
  "run": { "agent": "report", "task": "summarise yesterday", "maxDuration": "20m" },
  "notify": { "sink": "tg", "when": "always" } }
```

Standard crontab, optionally with a leading seconds field. `misfirePolicy` decides what
happens when the daemon was down at the moment a schedule should have fired:

- `skip` (default) — do not run it late. Right for reports: a "yesterday's summary"
  delivered at noon is confusing, not useful.
- `fireOnce` — run the most recent missed occurrence once, never once per occurrence
  missed. Catching up three days of daily reports helps nobody.

A schedule that fails three times in a row **trips a breaker** and stops firing, so one
broken job cannot eat the whole daily budget every day, nor send one identical failure
notification a day until somebody notices. `pi-reactor schedule ls` shows what is tripped;
clearing it is deliberately explicit (`schedule resume <id>`), so a reload for unrelated
reasons never silently restarts something you decided to stop.

### Webhook events

```jsonc
{ "on": { "type": "github", "id": "fix-on-label",
          "event": "issues", "action": ["labeled"], "any": ["pi:fix"] },
  "run": { "agent": "coder", "skill": "fix" },
  "notify": { "sink": "slack", "when": "always" } }
```

`event` must match; `action` and `any` narrow it when present, `any` being an OR over
labels. The delivery itself is the [webhook process](#webhooks)' job; this is only the
rule that decides which triggers it wakes.

Whatever fired the run is appended to the agent's prompt as a JSON block. "Fix the issue"
is not a usable instruction without knowing which issue.

## Notifications, and Continuing the Conversation

A notification carries the agent's final answer, the cost, and a way back in:

```
✅ nightly · report · 6s · 2.3k tokens

Three deploys yesterday, all green.

↩ pi-reactor resume 42
```

That last line closes the loop. `pi-reactor resume 42` opens run 42's transcript in your
own interactive Pi, in the directory the job ran in, with its full context — so the
follow-up question lands where the answer came from. Transcripts age out with the rest of
the history (30 days by default), and `resume` tells you plainly when one has.

Bodies are rendered per sink: Telegram gets its HTML subset, Slack gets mrkdwn. Long
output is split at paragraph boundaries rather than truncated. A `429` is obeyed by its
`retry_after` and does **not** consume the retry budget — throttling is not failure.
Messages that genuinely cannot be delivered are parked as dead letters and counted in
`pi-reactor status`, because "a notification you were promised is never coming" is
something you should be able to see.

## Webhooks

Anything that can POST a signed payload can trigger work. A separate process handles it,
because it is the only thing in the system that binds a public port — it holds no
database, no queue, and no credentials beyond the secrets it verifies with. The daemon
never listens on the network.

```bash
pi-reactor webhook --port 8787   # behind Cloudflare Tunnel, Tailscale Funnel, a reverse proxy…
```

```jsonc
// ~/.pi-reactor/webhooks.json — one entry per public endpoint
{ "endpoints": {
    "github": { "path": "/hooks/github", "provider": "github" } } }
```

One pipeline, whatever the source:

```
read (≤2 MiB) ──► verify ──► gates ──► CloudEvent ──► daemon socket
```

**Verification comes before parsing.** Until the signature checks out the body is entirely
attacker-controlled, and a JSON parser is a far larger surface than an HMAC comparison.

**The response code is the contract.** It matters more than it looks, because most
providers — GitHub among them — do *not* retry a failed delivery. Answer wrongly and the
event is simply gone.

| | |
|---|---|
| `401` | the signature did not check out |
| `204` | authentic, but no trigger wants it |
| `202` | queued — or a redelivery of something already queued |
| `503` | the daemon is unreachable, so replay this one |
| `200` | a handshake the provider expects a bare OK for |

### Providers

A provider is a *profile*, not a process: one function that verifies a request and
projects it into something triggers can match on. That works because the industry only has
four signature families, so a new source is roughly thirty lines rather than a new
listener.

| family | who | status |
|---|---|---|
| raw HMAC over the body | GitHub, Gitea | **implemented** |
| Standard Webhooks | OpenAI, Anthropic, Supabase, PagerDuty | not yet |
| timestamped proprietary HMAC | Stripe, Slack | not yet |
| static token comparison | GitLab | not yet |

Adding one means writing `src/webhook/provider-<name>.ts` against the same interface
GitHub uses and registering it. Nothing in the pipeline, the response codes, the queue or
the notification path changes — those are already provider-independent.

There is deliberately no unsigned provider. An endpoint anyone can POST to is an endpoint
anyone can spend your tokens through.

### The GitHub profile

The one that ships. Point a repository webhook at your endpoint and share the secret:

```bash
pi-reactor secret set github webhookSecret   # the same value you paste into GitHub
```

Two gates run before anything is queued, **in this order, and the order is load-bearing**:

1. **bot loop** — deliveries from a bot are dropped
2. **authorization** — `author_association` must be one of `OWNER`, `MEMBER`,
   `COLLABORATOR` (configurable per endpoint)

Your own bot is usually also a collaborator. The other way round lets a bot authorise
itself, and a comment-reply loop runs until the budget cap notices.

The payload is projected down to what an agent actually reads — repository, issue number,
title, body, labels, the comment — and appended to its prompt. Anything else is one `gh`
call away inside the job, fetched fresh rather than replayed from whenever the delivery
happened.

Reconciling failed deliveries needs no new machinery: point a cron trigger at
`gh api repos/{owner}/{repo}/hooks/{id}/deliveries` and let the scheduler you already have
do it.

## Configuration

One directory, `~/.pi-reactor/` (override with `PI_REACTOR_DIR`) — one operation each for
backup, migration and uninstall:

```
agents.json  sinks.json  triggers.json  webhooks.json   preferences and references only
credentials.json                                        0600, values inlined
state.db                                                queue and history
daemon.sock                                             0600 control plane
daemon.pid                                              singleton lock
```

**The daemon owns these files.** Every change goes through it — validated, written
atomically, applied without a restart — so validation exists in exactly one place and the
extension cannot drift from the CLI. Hand-editing works too; run `pi-reactor reload`
afterwards, and a bad edit is rejected while the previous configuration stays live.

**Credentials never enter a config file.** They live in `credentials.json` at 0600, which
is why the other files can be committed, shared when asking for help, and displayed in
full by the confirmation dialog. Values are read from `$CREDENTIALS_DIRECTORY` (systemd
`LoadCredential=`), then `credentials.json`, then the environment; provider keys fall back
to your own `~/.pi/agent/auth.json`, so `pi login` is usually all the setup there is.

## CLI

```
serve [options]              Run the daemon (singleton per directory)
webhook [--port 8787]        Run the public webhook listener
emit --agent <name> [...]    Enqueue a job now
status                       Queue depth, dead letters, today's spend
runs [--dead] [--limit N]    Recent run history
resume <run-id> [--print]    Continue that run's conversation in your own Pi
rerun <run-id>               Queue the same work again as a new job
notify --sink <s> <body>     Queue an outbound message (agents use this mid-run)
pause | resume               Durable queue switch; survives a restart
reload                       Re-read configuration from disk
doctor                       Preflight, with a fix for every failure
schedule ls | resume <id>    Cron watermarks and breaker state

agent   ls | add <name> --cwd <dir> --model <p/m> | rm <name>
sink    ls | add <name> --kind telegram --chat-id <n> | rm <name>
trigger ls | add <id> --schedule <cron> --agent <a> --task <t> | rm <id>
secret  set <name> <field>   Read a credential from stdin, never echoed

serve options:
  --concurrency <2>          Jobs at once (one per agent regardless)
  --daily-token-cap <N>      Refuse new work past N tokens today
  --retention-days <30>      Age at which rows and transcripts are reclaimed
  --shutdown-grace <60s>     Drain budget on SIGTERM
```

`--dry-run` on any configuration write shows the validated before/after without applying
it.

## Pi Extension

The other way to drive it. `pi install npm:pi-reactor` adds a `/reactor` command, six
`reactor_*` tools, and a skill that teaches the model how to use them. It runs inside your own interactive Pi and talks
to the daemon over its socket, so it works from any Pi session on the machine — whatever
directory you happen to be in.

### Just say it

The tools are there so you do not have to remember the CLI. Things that work:

> every morning at nine, summarise yesterday's commits and send it to Telegram

> what has pi-reactor been up to?

> the nightly job failed last night — what happened?

> move the nightly report to 10am, and stop telling me when it succeeds

> add an agent for ~/projects/api using sonnet

> run the report right now, I want to see the output before scheduling it

The model reads the current configuration first, composes the change, and the **daemon
validates it before you are asked anything**. What you approve is a document already known
to be good — being asked to approve something that then gets rejected is worse than not
being asked.

### The confirmation gate

A configuration change shows you the lines that moved, not both files in full:

```
edit trigger "nightly"

/home/me/.pi-reactor/triggers.json

          "type": "cron",
          "id": "nightly",
-         "schedule": "0 9 * * *",
+         "schedule": "0 10 * * *",
          "timezone": "Asia/Shanghai"
        },
```

Approve and it is live immediately — no restart, no reload. What gets a gate:

| | |
|---|---|
| `reactor_status`, `reactor_runs`, `reactor_config_get` | no prompt — reads |
| `reactor_pause` | no prompt — reversible, and durable across restarts |
| `reactor_config_set` | prompt, with the diff above |
| `reactor_emit` | prompt — it starts a real run and spends tokens |

### `/reactor`

For the things a conversation is the wrong shape for:

```
/reactor                  # same as /reactor status
/reactor status           # pid, queue depth, dead letters, today's spend, agents
/reactor secret tg        # prompts for a credential and stores it (see below)
/reactor secret tg botToken
/reactor pause            # stop claiming new work; jobs still queue
/reactor resume
```

### Credentials never pass through a tool

`/reactor secret <sink> [field]` prompts you in a dialog and hands the value straight to
the daemon, which writes it to a 0600 file. It is never a tool argument, so **it never
enters the model's context** — which is also why the configuration files themselves can be
displayed in full by the gate above, committed, or pasted into an issue when asking for
help.

### A job cannot use any of this

Batch jobs run with `-ne`, so the extension is not loaded in them at all. Even if it were,
`ctx.ui.confirm` becomes an `extension_ui_request` that the daemon answers `cancelled`,
which arrives as `false` and refuses the write. Unattended safety here is structural
rather than a rule someone has to remember.

## Agents Scheduling Themselves

A running job can create its own cron entries through a narrower door onto the same
storage: same validation, same breaker, plus three restrictions. A per-job token proves
the caller really is a running job, so what it writes is marked `aiAuthored` and stays
distinguishable from what you asked for. Only cron — a job cannot open a public endpoint.
And a quota, because an agent with a scheduler fails by making a hundred schedules, not
one bad one. A job may withdraw its own; only you can remove one you made.

## Safety Boundaries

The trust boundary is **this machine and your own repositories**. Within it:

- The public entrance is never the daemon. Its socket is 0600 and local.
- Only people with write access to the repository can trigger work — signature, then bot
  loop, then `author_association`, all before anything is queued.
- Job processes get an **explicitly constructed** environment: `PATH`, `HOME`, the
  provider key for their model, and the socket path. Not the daemon's environment.
  **Sink credentials never reach an agent** — sending a message is only possible through
  the socket, so a job that ingests a hostile issue body and gets prompt-injected can at
  most send extra messages through the proper channel.
- Provider variable names are derived from Pi's own table rather than hardcoded, because
  `ANTHROPIC_OAUTH_TOKEN` silently outranks `ANTHROPIC_API_KEY` — one stray inherited
  variable would change whose quota every job spends, with no error and no log line.
- Run history is PII-free: ids, states, durations, token counts. Transcripts are Pi's own
  session files, aged out on the same retention clock.

**If you ever open triggering to strangers** — accepting any issue author rather than
collaborators — container isolation stops being optional. The per-job token and the
prompt-level guardrails are guardrails against mistakes, not a boundary against someone
who already runs code as this user.

## Running as a Service

The daemon runs in the foreground and expects a service manager to own it — to start it
at boot, restart it after a crash, and keep it alive when you log out.
`pi-reactor service` prints a definition for whichever one this machine uses — read it,
then redirect it:

**Linux**

```bash
pi-reactor service > ~/.config/systemd/user/pi-reactor.service
systemctl --user daemon-reload
systemctl --user enable --now pi-reactor
loginctl enable-linger "$USER"

journalctl --user -u pi-reactor -f
```

**macOS**

```bash
pi-reactor service > ~/Library/LaunchAgents/dev.pi-reactor.daemon.plist
launchctl load ~/Library/LaunchAgents/dev.pi-reactor.daemon.plist

tail -f ~/Library/Logs/pi-reactor.log
```

**`enable-linger` is not optional on a server.** Without it the user manager stops when
your session ends, so the daemon dies with your SSH connection and the 09:00 schedule
never fires. It is the most common way a personal daemon quietly stops working.

The definition is generated rather than shipped as a file to edit, because the values that
matter are ones only a running process knows: the absolute path to *this* node, to *this*
install, and the `PATH` you are standing in. A service manager inherits none of your
shell, so a version manager (nvm, fnm, asdf) puts everything somewhere a template would
have to guess at — and agents inherit that `PATH` for their own tool calls, which is how
"works in my terminal" becomes "the job cannot find `git`". Regenerate after moving your
install rather than editing the file.

Stopping is graceful either way: `SIGTERM` stops new claims, in-flight jobs get their
drain budget, undelivered notifications flush, and only then does the process exit. Both
definitions allow more time for that than the daemon takes, so the graceful path actually
runs instead of being killed halfway.

Coming back is graceful too: jobs left running by a dead daemon are marked interrupted
*and you are told about them*, orphaned agent processes are reaped before anything new
starts, and a paused queue comes back paused.

## Development

```bash
npm test              # unit and integration; no network, no model calls
npm run test:contract # spawns real Pi, pinned to the verified version
npm run check         # typecheck + test
npm run build         # emit dist/ — only needed to publish
```

Development needs no build: Node strips types from the sources directly, and the tests
run them as they are. Publishing does need one, because Node refuses to strip types under
`node_modules` and no flag overrides it — an installed package has to ship JavaScript or
its CLI cannot start. `rewriteRelativeImportExtensions` is what lets one source tree serve
both: imports are written `./paths.ts` so Node runs them in place, and rewritten to
`./paths.js` on the way out. The contract tests are the upgrade gate:
the RPC protocol carries no semver promise, so run them before trusting a new Pi release.

## License

MIT
