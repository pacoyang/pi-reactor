/**
 * Generates the service definition for whichever init system is in front of you.
 *
 * Printed to stdout for the caller to redirect, the shape `podman generate
 * systemd` and `gh completion` both use: nothing is written to a system location
 * without being asked, and you can read it before you install it.
 *
 * The reason this is generated rather than a file shipped in the repo is that
 * the values that matter are ones only the running process knows. A checked-in
 * template has to say "now edit ExecStart to match your install", and every
 * person doing that by hand is a chance to get it wrong — especially with a
 * version manager, where nothing is where a template would guess.
 */
import { homedir, userInfo } from "node:os";
import type { Paths } from "./paths.ts";

export type ServiceKind = "systemd" | "launchd";

/**
 * Whose service manager runs it — an axis orthogonal to the init system, and one
 * both of them have.
 *
 *   user    systemd `--user` units, or a launchd LaunchAgent. Tied to a login
 *           session, so it needs `enable-linger` to outlive one.
 *   system  /etc/systemd/system, or a launchd LaunchDaemon. Starts at boot,
 *           needs no session, and inherits no HOME — which matters here, because
 *           the daemon reads ~/.pi-reactor and the agent reads ~/.pi/agent.
 */
export type ServiceScope = "user" | "system";

export interface ServiceUnitInput {
	paths: Paths;
	/** Absolute path to the node binary that will run the daemon. */
	execPath: string;
	/** Absolute path to this CLI's entry script. */
	scriptPath: string;
	/** The PATH agents will inherit for their own tool calls. */
	path: string;
	home: string;
	/** Account the daemon runs as. A system unit has to name it; a user unit already knows. */
	user: string;
	/** Set only when the operator overrode the directory, so the default stays implicit. */
	reactorDir?: string | undefined;
}

/** Defaults to whatever this machine uses. */
export function defaultServiceKind(platform: string = process.platform): ServiceKind {
	return platform === "darwin" ? "launchd" : "systemd";
}

/**
 * Defaults from who is running the command.
 *
 * root installs system services — it is the only account that can write
 * /etc/systemd/system, and on a server or in a container there is usually no
 * user session for a user unit to attach to at all. Getting this wrong is not a
 * loud failure: a user unit on such a box installs fine and then never starts,
 * with systemd reporting only that it cannot reach a session bus.
 */
export function defaultServiceScope(uid: number | undefined = process.getuid?.()): ServiceScope {
	return uid === 0 ? "system" : "user";
}

/**
 * Everything the generated unit needs, read from the process that is generating
 * it — which is the one the operator just proved works.
 *
 * PATH especially: agents inherit it for git, gh, npm and everything else they
 * shell out to. Guessing a minimal one is how "works in my terminal" becomes
 * "the job cannot find git", so the honest default is the PATH you are standing
 * in right now.
 */
export function serviceUnitInput(
	paths: Paths,
	env: NodeJS.ProcessEnv = process.env,
	argv: string[] = process.argv,
): ServiceUnitInput {
	return {
		paths,
		execPath: process.execPath,
		// The program to start is the one generating this file, which Node has
		// already resolved into argv[1] — absolute, and with the npm bin symlink
		// followed. No path arithmetic: deriving a sibling module's location by
		// rewriting this file's own name encodes the layout into a string pattern,
		// and every build or move breaks it silently. That is not hypothetical —
		// compiling to dist/ did exactly that, and the unit pointed at the wrong
		// file until it was caught.
		scriptPath: argv[1] ?? "",
		path: env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
		home: homedir(),
		user: userInfo().username,
		...(env.PI_REACTOR_DIR ? { reactorDir: paths.root } : {}),
	};
}

export function renderServiceUnit(kind: ServiceKind, scope: ServiceScope, input: ServiceUnitInput): string {
	return kind === "launchd" ? renderLaunchd(scope, input) : renderSystemd(scope, input);
}

/** Post-install instructions, printed to stderr so a redirect keeps the unit clean. */
export function serviceInstallHint(kind: ServiceKind, scope: ServiceScope): string {
	const lines =
		kind === "launchd"
			? scope === "system"
				? [
						"# Wrote a launchd daemon (system). To install it:",
						"#   sudo pi-reactor service --system > /Library/LaunchDaemons/dev.pi-reactor.daemon.plist",
						"#   sudo chown root:wheel /Library/LaunchDaemons/dev.pi-reactor.daemon.plist",
						"#   sudo launchctl load /Library/LaunchDaemons/dev.pi-reactor.daemon.plist",
						"#   sudo tail -f /var/log/pi-reactor.log",
					]
				: [
						"# Wrote a launchd agent (user). To install it:",
						"#   pi-reactor service > ~/Library/LaunchAgents/dev.pi-reactor.daemon.plist",
						"#   launchctl load ~/Library/LaunchAgents/dev.pi-reactor.daemon.plist",
						"#   tail -f ~/Library/Logs/pi-reactor.log",
					]
			: scope === "system"
				? [
						"# Wrote a systemd system unit. To install it:",
						"#   pi-reactor service --system > /etc/systemd/system/pi-reactor.service",
						"#   systemctl daemon-reload",
						"#   systemctl enable --now pi-reactor",
						"#   journalctl -u pi-reactor -f",
						"# A system unit starts at boot and needs no login session, so no lingering.",
					]
				: [
						"# Wrote a systemd user unit. To install it:",
						"#   pi-reactor service > ~/.config/systemd/user/pi-reactor.service",
						"#   systemctl --user daemon-reload",
						"#   systemctl --user enable --now pi-reactor",
						'#   loginctl enable-linger "$USER"    # or it dies when you log out',
						"#   journalctl --user -u pi-reactor -f",
					];
	return `${lines.join("\n")}\n`;
}

function renderSystemd(scope: ServiceScope, input: ServiceUnitInput): string {
	const environment = [`Environment=PATH=${input.path}`];
	if (input.reactorDir) environment.push(`Environment=PI_REACTOR_DIR=${input.reactorDir}`);

	// A system unit inherits no HOME, and the daemon needs one: its own directory
	// lives under it, and so does the pi login the agent spends. Naming the account
	// explicitly also covers generating with sudo for someone other than root.
	const identity =
		scope === "system"
			? `User=${input.user}\nEnvironment=HOME=${input.home}\n`
			: "";

	const header =
		scope === "system"
			? `#   pi-reactor service --system > /etc/systemd/system/pi-reactor.service
#   systemctl daemon-reload
#   systemctl enable --now pi-reactor
#
# A system unit starts at boot and belongs to no login session, so nothing has to
# linger for it to survive one ending.`
			: `#   pi-reactor service > ~/.config/systemd/user/pi-reactor.service
#   systemctl --user daemon-reload
#   systemctl --user enable --now pi-reactor
#   loginctl enable-linger "$USER"
#
# That last line is not optional on a server. Without lingering the user manager
# stops when your session ends, so the daemon dies with your SSH connection and
# a schedule that fires at 09:00 never does.`;

	return `# Generated by \`pi-reactor service\`. Regenerate rather than hand-editing:
# the paths below come from the install you generated it from.
#
${header}

[Unit]
Description=pi-reactor — scheduled and event-driven work for the pi coding agent
After=network-online.target

[Service]
Type=simple
${identity}ExecStart=${input.execPath} ${input.scriptPath} serve

# Agents inherit this PATH for their own tool calls — git, gh, npm. This is the
# PATH the daemon was generated from, which is the one you tested in.
${environment.join("\n")}

Restart=on-failure
RestartSec=5s

# Longer than the daemon's own drain budget (60s by default) so the graceful path
# actually runs: SIGTERM stops new claims, in-flight jobs finish, undelivered
# notifications flush, and only then does the process exit.
TimeoutStopSec=90s

# Logs are JSONL on stdout by design; journald owns rotation and querying.
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=${scope === "system" ? "multi-user" : "default"}.target
`;
}

function renderLaunchd(scope: ServiceScope, input: ServiceUnitInput): string {
	const extraEnv = input.reactorDir
		? `\n\t\t<key>PI_REACTOR_DIR</key>\n\t\t<string>${xml(input.reactorDir)}</string>`
		: "";

	const system = scope === "system";
	// A LaunchDaemon has no user to belong to, so the log cannot live in one, and
	// the account has to be named rather than assumed.
	const logPath = system ? "/var/log/pi-reactor.log" : `${input.home}/Library/Logs/pi-reactor.log`;
	const userName = system ? `\n\t<key>UserName</key>\n\t<string>${xml(input.user)}</string>\n` : "";

	const install = system
		? `    sudo pi-reactor service --system > /Library/LaunchDaemons/dev.pi-reactor.daemon.plist
    sudo chown root:wheel /Library/LaunchDaemons/dev.pi-reactor.daemon.plist
    sudo launchctl load /Library/LaunchDaemons/dev.pi-reactor.daemon.plist
    sudo tail -f /var/log/pi-reactor.log`
		: `    pi-reactor service > ~/Library/LaunchAgents/dev.pi-reactor.daemon.plist
    launchctl load ~/Library/LaunchAgents/dev.pi-reactor.daemon.plist
    tail -f ~/Library/Logs/pi-reactor.log`;

	return `<?xml version="1.0" encoding="UTF-8"?>
<!--
  Generated by \`pi-reactor service\`. Regenerate rather than hand-editing:
  the paths below come from the install you generated it from.

${install}
-->
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>dev.pi-reactor.daemon</string>${userName}

	<key>ProgramArguments</key>
	<array>
		<string>${xml(input.execPath)}</string>
		<string>${xml(input.scriptPath)}</string>
		<string>serve</string>
	</array>

	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<dict>
		<!-- Restart on a crash, but not when the daemon exits 0 on purpose:
		     a \`launchctl unload\`, or an operator in a hurry sending SIGTERM twice. -->
		<key>SuccessfulExit</key>
		<false/>
	</dict>

	<!-- Agents inherit this PATH for their own tool calls — git, gh, npm. This is
	     the PATH the daemon was generated from, which is the one you tested in. -->
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>${xml(input.path)}</string>
		<key>HOME</key>
		<string>${xml(input.home)}</string>${extraEnv}
	</dict>

	<key>WorkingDirectory</key>
	<string>${xml(input.home)}</string>

	<!-- launchd has no journald, so the JSONL goes to a file. Rotation is yours. -->
	<key>StandardOutPath</key>
	<string>${xml(logPath)}</string>
	<key>StandardErrorPath</key>
	<string>${xml(logPath)}</string>

	<!-- Give the drain its full budget before SIGKILL. -->
	<key>ExitTimeOut</key>
	<integer>90</integer>
</dict>
</plist>
`;
}

/** A home directory can contain & or <; a plist that does is not valid XML. */
function xml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
