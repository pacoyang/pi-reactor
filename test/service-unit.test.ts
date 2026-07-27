/**
 * The generated service definition.
 *
 * What matters is that it runs UNEDITED. A checked-in template has to say "now
 * fix ExecStart to match your install", and every person doing that by hand is a
 * chance to get it wrong — so these assert on the values a template could only
 * have guessed at.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolvePaths } from "../src/core/paths.ts";
import {
	renderServiceUnit,
	serviceUnitInput,
	defaultServiceKind,
	defaultServiceScope,
	serviceInstallHint,
	type ServiceUnitInput,
} from "../src/core/service-unit.ts";

const paths = resolvePaths({ PI_REACTOR_DIR: "/tmp/reactor-test" });

function input(overrides: Partial<ServiceUnitInput> = {}): ServiceUnitInput {
	return {
		paths,
		execPath: "/home/me/.nvm/versions/node/v24.14.0/bin/node",
		scriptPath: "/home/me/.npm-global/lib/node_modules/pi-reactor/src/cli.ts",
		path: "/home/me/.local/bin:/usr/bin:/bin",
		home: "/home/me",
		user: "me",
		...overrides,
	};
}

test("the unit points at absolute paths a template could not have known", () => {
	// The whole reason this is generated: nvm puts node somewhere no template
	// would guess, and a service manager inherits nothing from your shell.
	for (const kind of ["systemd", "launchd"] as const) {
		const unit = renderServiceUnit(kind, "user", input());
		assert.match(unit, /\.nvm\/versions\/node\/v24\.14\.0\/bin\/node/, kind);
		assert.match(unit, /node_modules\/pi-reactor\/src\/cli\.ts/, kind);
		assert.match(unit, /serve/, kind);
		assert.doesNotMatch(unit, /__HOME__|__PI_REACTOR__|<path>|TODO/, `${kind} must need no editing`);
	}
});

test("agents inherit the PATH you generated it from, not a guessed minimum", () => {
	// A minimal PATH is how "works in my terminal" turns into "the job cannot
	// find git" — at 3am, in a notification that does not say why.
	const unit = renderServiceUnit("systemd", "user", input({ path: "/opt/homebrew/bin:/usr/bin" }));
	assert.match(unit, /Environment=PATH=\/opt\/homebrew\/bin:\/usr\/bin/);
	assert.match(renderServiceUnit("launchd", "user", input({ path: "/opt/homebrew/bin:/usr/bin" })), /\/opt\/homebrew\/bin/);
});

test("a custom directory survives into the unit, and a default one stays implicit", () => {
	const custom = renderServiceUnit("systemd", "user", input({ reactorDir: "/srv/reactor" }));
	assert.match(custom, /Environment=PI_REACTOR_DIR=\/srv\/reactor/);
	assert.doesNotMatch(renderServiceUnit("systemd", "user", input()), /PI_REACTOR_DIR/,
		"the default location needs no stating; an override does");
});

test("the stop timeout exceeds the daemon's own drain budget", () => {
	// 60s of draining under a 90s deadline. The other way round and the graceful
	// path is killed halfway through flushing notifications nobody has seen yet.
	assert.match(renderServiceUnit("systemd", "user", input()), /TimeoutStopSec=90s/);
	assert.match(renderServiceUnit("launchd", "user", input()), /<key>ExitTimeOut<\/key>\s*<integer>90<\/integer>/);
});

test("launchd restarts a crash but not a deliberate stop", () => {
	const unit = renderServiceUnit("launchd", "user", input());
	assert.match(unit, /<key>SuccessfulExit<\/key>\s*<false\/>/,
		"`launchctl unload` must not be fought by KeepAlive");
});

test("a home directory containing XML metacharacters cannot break the plist", () => {
	const unit = renderServiceUnit("launchd", "user", input({ home: "/home/a&b<c", path: "/x&y" }));
	assert.doesNotMatch(unit, /<string>[^<]*[&][^a-z]/, "raw ampersand would make it invalid XML");
	assert.match(unit, /&amp;/);
});

test("the platform picks the format, and the install hint goes with it", () => {
	assert.equal(defaultServiceKind("darwin"), "launchd");
	assert.equal(defaultServiceKind("linux"), "systemd");
	assert.equal(defaultServiceKind("freebsd"), "systemd");

	// The hint is stderr-only prose, so a redirect leaves the unit file clean —
	// and it has to name lingering, which is the failure nobody debugs on their own.
	assert.match(serviceInstallHint("systemd", "user"), /enable-linger/);
	assert.match(serviceInstallHint("launchd", "user"), /launchctl load/);
});

test("serviceUnitInput reads the live process rather than being told", () => {
	const live = serviceUnitInput(paths, { PATH: "/live/path" });
	assert.equal(live.execPath, process.execPath);
	assert.equal(live.path, "/live/path");

	// The program to start is whichever one is generating the file. Taking it from
	// argv[1] rather than deriving it from this module's own filename is what makes
	// the unit survive a build: compiling to dist/ silently broke the derivation,
	// and the generated unit pointed at the wrong file.
	assert.equal(serviceUnitInput(paths, {}, ["node", "/opt/pi-reactor/dist/cli.js"]).scriptPath,
		"/opt/pi-reactor/dist/cli.js");
	assert.equal(serviceUnitInput(paths, {}, ["node", "/checkout/src/cli.ts"]).scriptPath,
		"/checkout/src/cli.ts", "a checkout runs the sources directly, and that is what it should start");
	assert.equal(live.reactorDir, undefined, "no PI_REACTOR_DIR in that env means the default is in use");
	assert.equal(serviceUnitInput(paths, { PI_REACTOR_DIR: "/srv/r" }).reactorDir, paths.root);
});

// ---------------------------------------------------------------- scope

test("scope defaults from who is running the command", () => {
	// A user unit installs fine on a root-only box and then never starts: systemd
	// reports only that it cannot reach a session bus. Guessing from the uid is
	// what keeps that failure from being the default.
	assert.equal(defaultServiceScope(0), "system");
	assert.equal(defaultServiceScope(501), "user");
	assert.equal(defaultServiceScope(undefined), "user", "no getuid (Windows) means no system scope to assume");
});

test("a systemd system unit targets boot and carries its own HOME", () => {
	const unit = renderServiceUnit("systemd", "system", input({ user: "root", home: "/root" }));

	assert.match(unit, /WantedBy=multi-user\.target/, "a system unit is wanted by boot, not by a session");
	assert.match(unit, /^User=root$/m, "named explicitly, so generating with sudo for someone else still works");
	assert.match(unit, /^Environment=HOME=\/root$/m,
		"a system unit inherits no HOME, and the daemon reads ~/.pi-reactor while the agent reads ~/.pi/agent");
	assert.doesNotMatch(unit, /enable-linger/, "lingering is a user-session concern and would only confuse here");
});

test("a systemd user unit keeps the session shape, and says what it needs", () => {
	const unit = renderServiceUnit("systemd", "user", input());

	assert.match(unit, /WantedBy=default\.target/);
	assert.doesNotMatch(unit, /^User=/m, "a user unit already knows whose it is");
	assert.doesNotMatch(unit, /^Environment=HOME=/m, "and inherits HOME from the session");
	assert.match(unit, /enable-linger/, "which is exactly why it has to mention lingering");
});

test("a LaunchDaemon names its account and keeps its log out of a home directory", () => {
	const daemon = renderServiceUnit("launchd", "system", input({ user: "root", home: "/var/root" }));

	assert.match(daemon, /<key>UserName<\/key>\s*<string>root<\/string>/);
	assert.match(daemon, /<string>\/var\/log\/pi-reactor\.log<\/string>/,
		"a system daemon belongs to no user, so its log cannot live in one");
	assert.doesNotMatch(daemon, /Library\/Logs/);

	const agent = renderServiceUnit("launchd", "user", input());
	assert.doesNotMatch(agent, /UserName/, "an agent runs as whoever loaded it");
	assert.match(agent, /\/home\/me\/Library\/Logs\/pi-reactor\.log/);
});

test("the install hint matches the scope it was generated for", () => {
	assert.match(serviceInstallHint("systemd", "system"), /\/etc\/systemd\/system/);
	assert.doesNotMatch(serviceInstallHint("systemd", "system"), /--user|enable-linger/);
	assert.match(serviceInstallHint("systemd", "user"), /systemctl --user/);

	assert.match(serviceInstallHint("launchd", "system"), /LaunchDaemons/);
	assert.match(serviceInstallHint("launchd", "system"), /sudo/, "writing there needs it, and so does loading it");
	assert.match(serviceInstallHint("launchd", "user"), /LaunchAgents/);
});
