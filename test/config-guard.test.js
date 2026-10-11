"use strict";

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const APP = path.join(__dirname, "..", "app.js");

function run(env) {
  // Start the real entry point; a guard that throws exits before listening.
  return spawnSync(process.execPath, [APP], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, PORT: "0", ...env },
    encoding: "utf8",
    timeout: 5000,
  });
}

test("production + auth enabled without SESSION_SECRET refuses to start", () => {
  const r = run({ NODE_ENV: "production", AUTH_ENABLED: "true", SESSION_SECRET: "" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /SESSION_SECRET must be set/);
});

test("guest-only production does not require SESSION_SECRET", () => {
  // It boots and listens, so it is still running when the timeout kills it.
  const r = run({ NODE_ENV: "production", AUTH_ENABLED: "false", SESSION_SECRET: "" });
  assert.doesNotMatch(r.stderr, /SESSION_SECRET must be set/);
});
