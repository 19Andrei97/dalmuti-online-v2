/* Unit tests for the client's rule hint (playableRanks) and the selection
 * model. The client is TypeScript, so we bundle the two modules with esbuild
 * (the same tool the real build uses) into a temp ESM file and import it. */

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const outdir = fs.mkdtempSync(path.join(os.tmpdir(), "dalmuti-client-"));
const outfile = path.join(outdir, "client.mjs");

esbuild.buildSync({
  stdin: {
    contents:
      'export * from "./src/ts/client-rules";\n' +
      'export { SelectionModel } from "./src/ts/selection";\n',
    resolveDir: root,
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node18",
  outfile,
  logLevel: "silent",
});

const client = await import(pathToFileURL(outfile).href);
const { playableRanks, classifyMove, fieldCount, SelectionModel } = client;

const JOKER = 13;

test("playableRanks gives no hint when leading", () => {
  assert.equal(playableRanks(null, true), null);
  assert.equal(playableRanks({ num: 0, count: 0, by: "" }, true), null);
});

test("playableRanks keeps every lower rank and the Joker for a two-card field", () => {
  // Field: two 5s -> follow with two of any lower rank, or {Joker, lower rank}.
  const ranks = playableRanks({ num: 5, count: 2, by: "x" }, false);
  assert.deepEqual([...ranks].sort((a, b) => a - b), [1, 2, 3, 4, JOKER]);
  assert.ok(!ranks.has(5), "the field's own rank is not playable");
  assert.ok(ranks.has(4), "a rank just below the field is playable");
  assert.ok(ranks.has(3), "the field count does not cap which ranks are playable");
});

test("playableRanks excludes the Joker unless the field demands two cards", () => {
  // Field: a single 3 -> answer with a single lower card; a Joker pair is two
  // cards and can never match a one-card field.
  const single = playableRanks({ num: 3, count: 1, by: "x" }, false);
  assert.deepEqual([...single].sort((a, b) => a - b), [1, 2]);
  assert.ok(!single.has(JOKER));

  // Field: three 3s -> no Joker either (only single-rank sets of three exist).
  const triple = playableRanks({ num: 3, count: 3, by: "x" }, false);
  assert.deepEqual([...triple].sort((a, b) => a - b), [1, 2]);
  assert.ok(!triple.has(JOKER));
});

test("selection model: unplayable ranks cannot be picked", () => {
  const sel = new SelectionModel();
  sel.setHand([1, 5, 5, JOKER]);
  sel.setLimit(2);
  sel.setPlayable(new Set([1, JOKER]));

  assert.equal(sel.toggleRank(5), false);
  assert.equal(sel.selectedCountOf(5), 0);
  assert.equal(sel.toggleRank(1), true);
  assert.equal(sel.selectedCountOf(1), 1);
  assert.equal(sel.isPlayable(5), false);
  assert.equal(sel.isPlayable(1), true);
});

test("selection model: bulk pick is capped to the cards the field needs", () => {
  const sel = new SelectionModel();
  sel.setHand([1, 1, 1, 1]);
  sel.setLimit(2);
  assert.equal(sel.toggleRank(1), true);
  assert.equal(sel.selectedCountOf(1), 2, "picks only the two cards required");
  assert.equal(sel.toggleRank(1), true);
  assert.equal(sel.selectedCountOf(1), 0);
});

test("selection model: bulk pick selects every copy when leading", () => {
  const sel = new SelectionModel();
  sel.setHand([1, 1, 1, 1]);
  sel.setLimit(0);
  sel.setPlayable(null);
  sel.toggleRank(1);
  assert.equal(sel.selectedCountOf(1), 4);
});

test("selection model: single pick never exceeds the field count", () => {
  const sel = new SelectionModel();
  sel.setHand([2, 2]);
  sel.setLimit(1);
  sel.setPlayable(null);
  assert.equal(sel.toggleOne(2), true);
  assert.equal(sel.selectedCountOf(2), 1);
  // A second press on a fully-picked rank toggles the copy back off rather than
  // exceeding the one-card limit.
  assert.equal(sel.toggleOne(2), true);
  assert.equal(sel.selectedCountOf(2), 0);
  // And it can be picked again.
  assert.equal(sel.toggleOne(2), true);
  assert.equal(sel.selectedCountOf(2), 1);
});

test("selection model: setHand drops selections no longer held", () => {
  const sel = new SelectionModel();
  sel.setHand([3, 3]);
  sel.toggleRank(3);
  assert.equal(sel.selectedCountOf(3), 2);
  sel.setHand([4]);
  assert.equal(sel.selectedCountOf(3), 0);
});

test("classifyMove mirrors the server's lead/follow rules", () => {
  assert.equal(classifyMove(null, {}, true), "invalid"); // empty lead
  assert.equal(classifyMove(null, {}, false), "pass"); // empty follow passes
  assert.equal(classifyMove(null, { 1: 2 }, true), "play"); // lead a set
  assert.equal(classifyMove(null, { [JOKER]: 1 }, true), "invalid"); // lone Joker
  assert.equal(classifyMove(null, { [JOKER]: 1, 2: 1 }, true), "play"); // Joker + rank
  assert.equal(classifyMove({ num: 5, count: 2, by: "x" }, { 4: 2 }, false), "play");
  assert.equal(classifyMove({ num: 5, count: 2, by: "x" }, { 6: 2 }, false), "invalid");
  assert.equal(classifyMove({ num: 5, count: 2, by: "x" }, { 4: 1 }, false), "invalid"); // wrong count
});

test("fieldCount reports the cards a follow must match", () => {
  assert.equal(fieldCount(null), 0);
  assert.equal(fieldCount({ num: 4, count: 3, by: "x" }), 3);
});

test("playableRanks agrees with the server engine for every field", async () => {
  const engine = await import(
    pathToFileURL(path.join(root, "server", "game-engine.js")).href
  );
  const { checkRule } = engine;

  for (let num = 1; num <= JOKER; num++) {
    for (let count = 1; count <= 4; count++) {
      const last = { num, count, by: "x" };
      const hint = playableRanks(last, false);

      for (let rank = 1; rank < JOKER; rank++) {
        // A rank answers the field iff a same-count set of it is a legal follow.
        const legal = checkRule(last, { [rank]: count });
        assert.equal(
          hint.has(rank),
          legal,
          `field ${count}x${num}: rank ${rank} hint=${hint.has(rank)} engine=${legal}`
        );
      }

      // The Joker is playable iff some {Joker, lower rank} pair is a legal follow.
      const jokerLegal = Array.from({ length: num - 1 }, (_, i) => i + 1).some((r) =>
        checkRule(last, { [JOKER]: 1, [r]: 1 })
      );
      assert.equal(
        hint.has(JOKER),
        jokerLegal,
        `field ${count}x${num}: Joker hint=${hint.has(JOKER)} engine=${jokerLegal}`
      );
    }
  }
});
