---
name: operate-pi-reactor
description: Configure and operate pi-reactor — schedule recurring agent work, route results to Telegram, and diagnose runs that failed. Use when the user wants something to run on a schedule, asks what pi-reactor is doing, or asks why a scheduled job did not produce what they expected.
---

# Operating pi-reactor

pi-reactor is a daemon on this machine that runs agent work on a schedule and
delivers the results somewhere. You configure it through the `reactor_*` tools,
which talk to the daemon over a unix socket. You never edit its files directly:
the daemon validates every change, writes it atomically, and applies it without a
restart. Editing files behind its back gets you two writers and no validation.

## The three things it is made of

- **agent** — a working directory plus a model. The thing that does the work.
  `{cwd, model: "provider/model-id", maxDuration?}`
- **sink** — where a notification goes. `{kind: "telegram", chatId}` or
  `{kind: "slack-webhook"}`, whose incoming-webhook URL is itself the credential.
- **trigger** — when to run, what to run, and who to tell.
  `{on: {type: "cron", id, schedule, timezone?, misfirePolicy?},
    run: {agent, task | skill, maxDuration?},
    notify?: {sink, when: "success" | "failure" | "always"}}`

A trigger names an agent and a sink, so both must exist first. The daemon will
refuse a trigger that points at something undefined, and say which.

## How to work

**Read before you write.** `reactor_config_get` shows what is there now.
Changes to an existing entry replace it wholesale — there is no patching — so
fetch the entry, modify it, and send the whole thing back.

**One change at a time.** Each call shows the user a before/after and waits for
approval. Batching three edits into one turn means three dialogs in a row and no
clear place to say no.

**Let the daemon refuse you.** Do not pre-validate cron expressions or paths in
your head. Send the change; a refusal comes back with the reason, and it costs
nothing because nothing was written.

## Schedules

Standard crontab: `minute hour day month weekday`, optionally with a leading
seconds field. `0 9 * * *` is 09:00 daily. Always ask which timezone if the user
has not said and the schedule is time-of-day sensitive — the default is the
daemon's local time, which is rarely what someone means by "9am" when they are
travelling.

`misfirePolicy` decides what happens when the daemon was down at the moment a
schedule should have fired:

- `skip` (default) — do not run it late. Right for reports: a "yesterday's
  summary" delivered at noon is confusing, not useful.
- `fireOnce` — run the most recent missed occurrence once, never once per
  occurrence missed. Right for work that still needs doing whenever it happens.

## Credentials

**Never accept a token, key or password as a tool argument, and never write one
into a configuration entry.** Anything you receive is in the conversation and in
the model's context from then on.

When a sink needs a credential, tell the user to run `/reactor secret <sink>`.
That prompts them directly, and the value goes straight to a 0600 file the
daemon owns. This is why the configuration files can be shown in full, shared
when asking for help, or committed.

## Diagnosing

`reactor_status` first — it shows whether the queue is paused, whether anything
is running, and whether notifications are stuck undelivered. A non-zero DEAD
count in the outbox means a message was given up on: something is wrong with the
sink, usually its credential.

`reactor_runs` with `failedOnly` shows what failed and why. The reasons mean
different things:

- `timeout` — the run hit its `maxDuration`. Raise it, or narrow the task.
- `budget_exceeded` — the daily token cap refused it. Clears at midnight UTC.
- `config_error` — a missing credential, a missing directory, a dirty tree when
  the trigger asked for a clean one. Fix the configuration.
- `provider_error` / `crash` — infrastructure. These retry on their own, up to
  three times with backoff; if you see one it may already have recovered.
- `interrupted` — the daemon itself stopped mid-run. Whether the work landed is
  unknown, which is why it is not retried automatically. Offer to re-run it.

A schedule that keeps failing trips a breaker after three consecutive failures
and stops firing, so it cannot burn a day's budget every day. `reactor_status`
will not show that — the daemon's `schedule` listing will, and clearing it is
deliberately a separate, explicit step (`pi-reactor schedule resume <id>`) so a
schedule someone stopped does not silently restart.

## Schedules an agent made for itself

A job can create its own cron schedules with `pi-reactor schedule add`, which is
a narrower door onto the same storage: cron only, quota-limited, and everything
it writes is marked `aiAuthored`. `reactor_config_get` shows that marking, and it
is worth pointing out when the user is looking at their configuration and asks
why an entry is there that they do not remember writing.

An agent can withdraw its own; only an operator can remove one a human made.

## Trying something before scheduling it

`reactor_emit` runs a task once, right now. Suggest it when the user is
describing something new: a task that reads well in conversation often turns out
to need a sharper prompt, and finding that out on a real run beats finding it out
at 3am from a notification that says nothing useful.
