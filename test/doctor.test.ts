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
import { piVersionSupported, formatChecks, SUPPORTED_PI_RANGE, VERIFIED_PI_VERSION, type Check } from "../src/daemon/doctor.ts";

test("the supported range covers a minor, not a point", () => {
	assert.ok(piVersionSupported("0.82.0"), "the floor is inclusive");
	assert.ok(piVersionSupported("0.82.1"), "a patch above it is what installs actually get");
	assert.ok(piVersionSupported("0.82.17"), "and so is every later patch");

	// The upper bound is not caution for its own sake: the RPC protocol carries no
	// semver promise across minors, and nothing has tested the next one.
	assert.equal(piVersionSupported("0.83.0"), false);
	assert.equal(piVersionSupported("0.81.9"), false, "below the floor is unsupported too");
	assert.equal(piVersionSupported("1.0.0"), false);
});

test("an unparseable version is not quietly treated as supported", () => {
	for (const v of ["unknown", "", "0.82", "v0.82.1-beta"]) {
		assert.equal(piVersionSupported(v), false, v);
	}
});

test("the verified release is inside the range it is verified within", () => {
	// Provenance that contradicts the policy would be worse than none.
	assert.ok(piVersionSupported(VERIFIED_PI_VERSION), `${VERIFIED_PI_VERSION} vs ${SUPPORTED_PI_RANGE}`);
});

test("a warning is visible, and still exits zero", () => {
	// The whole point of the third state: unverified is worth saying and not worth
	// failing, so `doctor` in a script keeps meaning "this install is broken".
	const checks: Check[] = [
		{ ok: true, label: "fine" },
		{ ok: true, warn: true, label: "supported but unverified", note: "verified 0.82.1" },
	];
	const { text, ok } = formatChecks(checks);

	assert.equal(ok, true, "a warning must not fail the command");
	assert.match(text, /^! supported but unverified {2}\(verified 0\.82\.1\)$/m, "distinct from ✓ at a glance");
	assert.match(text, /^✓ fine$/m);
});

test("a failure still fails, and still says what to do", () => {
	const { text, ok } = formatChecks([{ ok: false, label: "broken", fix: "do the thing" }]);
	assert.equal(ok, false);
	assert.match(text, /^✗ broken$/m);
	assert.match(text, /^ {4}→ do the thing$/m);
});
