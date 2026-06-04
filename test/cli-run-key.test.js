"use strict";

const assert = require("assert");
const { resolveCliRunKey } = require("../out/cli-run-key.js");

assert.equal(resolveCliRunKey("mobile-1", "uuid-abc", false), "sid:uuid-abc");
assert.ok(resolveCliRunKey("mobile-1", undefined, true).startsWith("new:mobile-1:"));
assert.equal(resolveCliRunKey(undefined, undefined, false), "client:global");

console.log("cli-run-key.test.js OK");
