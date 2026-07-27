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
import { piVersionSupported } from "../src/daemon/doctor.ts";

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
