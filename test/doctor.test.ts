/**
 * The version policy, which is a policy and not a fact about one release.
 *
 * A package states compatibility as a range and lets a lockfile state what was
 * installed. Asserting one exact version instead makes the check red for almost
 * every install the moment upstream publishes a patch — and a check that is
 * usually red is a check nobody reads, which costs more than the drift it was
 * watching for.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { piVersionSupported, isLocalExtension } from "../src/daemon/doctor.ts";

test("support is asserted for a minor, not for a point", () => {
	assert.ok(piVersionSupported("0.82.0"));
	assert.ok(piVersionSupported("0.82.1"), "the patch installs actually resolve");
	assert.ok(piVersionSupported("0.82.17"), "and every later one, which is what a range means");

	// Not caution for its own sake: the RPC protocol carries no semver promise
	// across minors, and the contract tests reach exactly one of them.
	assert.equal(piVersionSupported("0.83.0"), false);
	assert.equal(piVersionSupported("0.81.9"), false);
	assert.equal(piVersionSupported("1.0.0"), false);
});

test("a version that cannot be read is not quietly treated as supported", () => {
	for (const v of ["unknown", "", "0.82", "x.y.z"]) assert.equal(piVersionSupported(v), false, JSON.stringify(v));
});

test("only extensions named by path are ours to check for", () => {
	// Measured against a live daemon: an agent with `npm:` extensions ran
	// perfectly while doctor reported both as missing, because the check statted
	// the spec string. Where pi puts a fetched extension is pi's business, and a
	// check that is always red is a check nobody reads.
	for (const spec of ["npm:pi-sub2api", "npm:pi-glean@1.2.3", "github:owner/repo", "git:x", "https://e.example/x.ts", "ssh://g/x"]) {
		assert.equal(isLocalExtension(spec), false, spec);
	}

	// Everything else is a path to pi (utils/paths.js:26), including a bare name.
	for (const spec of ["/root/.pi/agent/npm/node_modules/pi-glean/src/index.ts", "./local.ts", "~/x.ts", "plain-name.ts"]) {
		assert.equal(isLocalExtension(spec), true, spec);
	}

	assert.equal(isLocalExtension("  npm:pi-glean  "), false, "pi trims before deciding, so this must too");
});
