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
		...overrides,
	};
}

test("the unit points at absolute paths a template could not have known", () => {
	// The whole reason this is generated: nvm puts node somewhere no template
	// would guess, and a service manager inherits nothing from your shell.
	for (const kind of ["systemd", "launchd"] as const) {
		const unit = renderServiceUnit(kind, input());
		assert.match(unit, /\.nvm\/versions\/node\/v24\.14\.0\/bin\/node/, kind);
		assert.match(unit, /node_modules\/pi-reactor\/src\/cli\.ts/, kind);
		assert.match(unit, /serve/, kind);
		assert.doesNotMatch(unit, /__HOME__|__PI_REACTOR__|<path>|TODO/, `${kind} must need no editing`);
	}
});

test("agents inherit the PATH you generated it from, not a guessed minimum", () => {
	// A minimal PATH is how "works in my terminal" turns into "the job cannot
	// find git" — at 3am, in a notification that does not say why.
	const unit = renderServiceUnit("systemd", input({ path: "/opt/homebrew/bin:/usr/bin" }));
	assert.match(unit, /Environment=PATH=\/opt\/homebrew\/bin:\/usr\/bin/);
	assert.match(renderServiceUnit("launchd", input({ path: "/opt/homebrew/bin:/usr/bin" })), /\/opt\/homebrew\/bin/);
});

test("a custom directory survives into the unit, and a default one stays implicit", () => {
	const custom = renderServiceUnit("systemd", input({ reactorDir: "/srv/reactor" }));
	assert.match(custom, /Environment=PI_REACTOR_DIR=\/srv\/reactor/);
	assert.doesNotMatch(renderServiceUnit("systemd", input()), /PI_REACTOR_DIR/,
		"the default location needs no stating; an override does");
});

test("the stop timeout exceeds the daemon's own drain budget", () => {
	// 60s of draining under a 90s deadline. The other way round and the graceful
	// path is killed halfway through flushing notifications nobody has seen yet.
	assert.match(renderServiceUnit("systemd", input()), /TimeoutStopSec=90s/);
	assert.match(renderServiceUnit("launchd", input()), /<key>ExitTimeOut<\/key>\s*<integer>90<\/integer>/);
});

test("launchd restarts a crash but not a deliberate stop", () => {
	const unit = renderServiceUnit("launchd", input());
	assert.match(unit, /<key>SuccessfulExit<\/key>\s*<false\/>/,
		"`launchctl unload` must not be fought by KeepAlive");
});

test("a home directory containing XML metacharacters cannot break the plist", () => {
	const unit = renderServiceUnit("launchd", input({ home: "/home/a&b<c", path: "/x&y" }));
	assert.doesNotMatch(unit, /<string>[^<]*[&][^a-z]/, "raw ampersand would make it invalid XML");
	assert.match(unit, /&amp;/);
});

test("the platform picks the format, and the install hint goes with it", () => {
	assert.equal(defaultServiceKind("darwin"), "launchd");
	assert.equal(defaultServiceKind("linux"), "systemd");
	assert.equal(defaultServiceKind("freebsd"), "systemd");

	// The hint is stderr-only prose, so a redirect leaves the unit file clean —
	// and it has to name lingering, which is the failure nobody debugs on their own.
	assert.match(serviceInstallHint("systemd"), /enable-linger/);
	assert.match(serviceInstallHint("launchd"), /launchctl load/);
});

test("serviceUnitInput reads the live process rather than being told", () => {
	const live = serviceUnitInput(paths, { PATH: "/live/path" });
	assert.equal(live.execPath, process.execPath);
	assert.match(live.scriptPath, /cli\.ts$/, "the daemon is started by script path, needing no PATH lookup");
	assert.equal(live.path, "/live/path");
	assert.equal(live.reactorDir, undefined, "no PI_REACTOR_DIR in that env means the default is in use");
	assert.equal(serviceUnitInput(paths, { PI_REACTOR_DIR: "/srv/r" }).reactorDir, paths.root);
});
