# Installing pi-reactor on a machine

Read this when asked to install or set up pi-reactor, on this machine or over SSH.

The order below is deliberate. Every step after the survey depends on what the survey
found, and the things that go wrong here go wrong *quietly* — a service that installs
cleanly and never starts, a schedule that fires at the wrong hour, an agent that cannot
reach the network.

## 1. Survey before touching anything

Report what you find before making changes. Each of these has bitten a real install:

```bash
node -v                              # >= 22.19 is a hard requirement, not a preference
command -v pi && pi --version        # pi is the engine; without it nothing runs
ls ~/.pi/agent/                      # auth.json, settings.json, telegram.json may exist
ls ~/.pi-reactor/                    # already installed? do not overwrite a working setup
systemctl is-system-running          # and whether `systemctl --user` works at all
date; timedatectl show -p Timezone --value
curl -sS -o /dev/null -w '%{http_code}' https://api.github.com    # can agents reach out?
```

**A non-interactive SSH command does not source `~/.bashrc`.** If `node` or `pi` appear
missing, look again with an explicit path before concluding they are absent — a version
manager (nvm, fnm, asdf) puts them somewhere only an interactive shell knows:

```bash
ls -d ~/.nvm/versions/node/*/bin 2>/dev/null
cat ~/.nvm/alias/default 2>/dev/null
```

Use absolute paths for everything from here on. The service manager will not have your
shell's `PATH` either, which is the same problem wearing a different hat.

**Read the existing pi configuration rather than asking for things it already has.**
`~/.pi/agent/settings.json` names the default provider and model. `~/.pi/agent/auth.json`
lists which providers are logged in. If `~/.pi/agent/telegram.json` exists, pi-telegram is
set up and its bot can be reused — `profiles.default.allowedUserId` is the chat id for a
direct message. Two processes may **send** through one bot safely; only receiving
conflicts.

## 2. Install

```bash
npm install -g pi-reactor
pi-reactor doctor        # expect failures here; it lists what is still missing
```

## 3. Ask before configuring

Do not guess these. Ask, then configure:

1. **What should the agent do, and where?** A working directory and a model. Prefer an
   empty directory made for the purpose over an existing project — the agent can run
   commands there.
2. **Where do results go?** Telegram needs a bot token and a chat id; Slack needs an
   incoming webhook URL. Check whether pi-telegram is already configured first.
3. **When?** A cron expression *and* a timezone. Servers usually run UTC — set the
   trigger's `timezone` rather than changing the machine clock, which would affect
   everything else on it.
4. **A daily spend ceiling?** On an unattended machine, recommend one.

**The cap is counted in tokens, not currency.** If a budget is given in dollars, say that
you cannot convert it exactly — pricing depends on the provider and model — propose a
conservative token number, and suggest reconciling against the first real bill.

## 4. Configure

```bash
pi-reactor agent add <name> --cwd <dir> --model <provider>/<model>
pi-reactor sink  add tg --chat-id <id>
pi-reactor trigger add <id> --schedule "0 9 * * *" --timezone Asia/Shanghai \
  --agent <name> --task "…" --notify tg --dry-run     # inspect, then drop --dry-run
```

**Never put a secret on a command line** — it lands in shell history and in every `ps` on
the machine. `pi-reactor secret set <name> <field>` reads from stdin:

```bash
pi-reactor secret set tg botToken < /path/to/a/file      # or a pipe, never an argument
```

Do not print a token you read, either. Pipe it.

**If the provider is registered by a pi extension** rather than built in, name that
extension on the agent. Batch jobs run with `-ne`, so nothing is loaded that was not
asked for, and the run otherwise fails at startup with `Unknown provider` — at 09:00,
not at the point you configured it. `-e` takes a path, so pass the extension's entry
file, which `pi.extensions` in its package.json names:

```bash
pi-reactor agent add <name> --cwd <dir> --model <provider>/<model> \
  --extension ~/.pi/agent/npm/node_modules/<pkg>/src/index.ts    # repeatable
```

## 5. Make it survive a reboot

```bash
pi-reactor service > <path>      # it picks user or system by whether you are root
```

Follow the instructions it prints to stderr. Two failure modes to avoid:

- A **user** service needs `loginctl enable-linger`, or it dies when the SSH session ends.
- A **user** service does not work at all where there is no session bus — containers,
  most root-only servers. `systemctl --user` fails with a message about
  `$DBUS_SESSION_BUS_ADDRESS`. Use `--system` there.

Regenerate rather than hand-editing: the paths in the file come from the install it was
generated on.

## 6. Verify, end to end

Do not stop at "the service is running":

```bash
pi-reactor doctor                                   # every line green
pi-reactor emit --agent <name> --task "…" --notify tg
pi-reactor runs                                     # outcome and token count
```

Confirm the notification actually arrived. A run that succeeds and a message that lands
are two different claims.

## Things that will bite you

- **pi has no web tool.** Its tools are `bash`, `edit`, `find`, `grep`, `ls`, `read`,
  `write`, and it does not speak MCP. An agent reaches the network through `bash` — `curl`
  against an API or an RSS feed. If the task needs search, that has to be arranged.
- **Do not disturb what is already there.** Other services may be running. Do not change
  the system clock, the firewall, or existing pi configuration.
- **The agent can run commands in its working directory.** On a server that is real
  authority. It is worth saying so when proposing where to point it.
