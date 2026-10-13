"use strict";

// Language dictionaries must stay in lockstep: a missing key renders the raw
// "language.xxx" token to the player, and a stray placeholder is worse (it is
// shown literally). This guards both the server-emitted keys and the client's
// runtime-built labels.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const DIR = path.join(__dirname, "..", "src", "js", "language");
const LANGS = ["en", "it", "bg"];

function load(lang) {
  return JSON.parse(fs.readFileSync(path.join(DIR, `${lang}.json`), "utf8"));
}

test("every language has the same set of keys", () => {
  const base = Object.keys(load("en")).sort();
  for (const lang of LANGS.slice(1)) {
    assert.deepEqual(Object.keys(load(lang)).sort(), base, `${lang} keys differ from en`);
  }
});

test("no translation is empty and placeholders match the English source", () => {
  const en = load("en");
  const placeholders = (s) => (String(s).match(/\{[a-z]+\}/g) || []).sort();
  for (const lang of LANGS) {
    const dict = load(lang);
    for (const [key, value] of Object.entries(dict)) {
      if (Array.isArray(value)) {
        assert.ok(value.every((v) => typeof v === "string" && v.length), `${lang}.${key} has an empty entry`);
        continue;
      }
      assert.ok(typeof value === "string" && value.length, `${lang}.${key} is empty`);
      assert.deepEqual(placeholders(value), placeholders(en[key]), `${lang}.${key} placeholders differ`);
    }
  }
});

test("keys the client builds at runtime exist in every language", () => {
  // These are referenced by src/ts/main.ts (wonTrick and sessionScore use a
  // {name}/{target} placeholder).
  const required = [
    "wonTrick",
    "leadNow",
    "newTrick",
    "wonHand",
    "youWonHand",
    "autoPassIn",
    "sessionScore",
    "sessionWon",
    "sessionOver",
    "resetSession",
  ];
  for (const lang of LANGS) {
    const dict = load(lang);
    for (const key of required) assert.ok(dict[key], `${lang} is missing ${key}`);
  }
});
