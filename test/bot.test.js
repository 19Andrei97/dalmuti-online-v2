"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const bot = require("../server/bot");
const engine = require("../server/game-engine");
const { JOKER } = engine;

test("enumeratePlays only returns legal plays for the current field", () => {
  const hand = [3, 3, 5, 13];
  // Leading: singles and doubles of every rank (Jokers allowed only paired).
  const leads = bot.enumeratePlays(hand, null);
  for (const play of leads) assert.equal(engine.checkRule(null, play), true, JSON.stringify(play));
  assert.ok(leads.some((p) => p[3] === 2), "double 3 available");
  assert.ok(!leads.some((p) => p[JOKER] === 1), "a lone Joker cannot lead");

  // Following a double: only doubles / card+Joker combos that beat it.
  const following = bot.enumeratePlays(hand, { num: 4, count: 2 });
  assert.ok(following.length > 0);
  for (const play of following) {
    assert.equal(engine.checkRule({ num: 4, count: 2 }, play), true, JSON.stringify(play));
    assert.equal(engine.selectionCount(play), 2);
  }
  assert.ok(following.some((p) => p[3] === 2));
  assert.ok(following.some((p) => p[3] === 1 && p[JOKER] === 1));
});

test("a bot with nothing that can beat the field passes", () => {
  const hand = [10, 11];
  assert.equal(bot.choosePlay(hand, { num: 3, count: 1 }, bot.DIFFICULTY.HARD), null);
  assert.equal(bot.choosePlay(hand, { num: 3, count: 2 }, bot.DIFFICULTY.MEDIUM), null);
});

test("hard bots preserve Jokers when a plain play can beat the field", () => {
  // Holding a pair of 3s and a Joker against a pair of 5s: {3:2} beats it, so
  // the Joker stays in hand.
  const hand = [3, 3, JOKER];
  const play = bot.choosePlay(hand, { num: 5, count: 2 }, bot.DIFFICULTY.HARD);
  assert.deepEqual(play, { 3: 2 });
});

test("hard bots spend the Joker when it is the only way to follow", () => {
  // Only one 3, so the Joker is the sole way to match the pair count.
  const hand = [3, JOKER];
  const play = bot.choosePlay(hand, { num: 5, count: 2 }, bot.DIFFICULTY.HARD);
  assert.deepEqual(play, { 3: 1, [JOKER]: 1 });
});

test("medium bots shed their highest cards", () => {
  const hand = [2, 3, 9];
  const play = bot.choosePlay(hand, null, bot.DIFFICULTY.MEDIUM);
  assert.deepEqual(play, { 9: 1 });
});

test("easy bots always return a legal play (never an illegal one)", () => {
  const hand = [1, 4, 4, 7, 13];
  let calls = 0;
  const rng = () => {
    calls++;
    return (calls * 0.37) % 1;
  };
  for (let i = 0; i < 25; i++) {
    const play = bot.choosePlay(hand, null, bot.DIFFICULTY.EASY, rng);
    assert.ok(play, "a legal lead exists");
    assert.equal(engine.checkRule(null, play), true, JSON.stringify(play));
    assert.equal(engine.checkValidity(hand, play), true);
  }
});

test("tax: peons give their best cards, dalmutis return their worst", () => {
  const hand = [1, 2, 11, 12];
  assert.deepEqual(
    bot.chooseTax(hand, 2, "peon", bot.DIFFICULTY.MEDIUM),
    [1, 2]
  );
  assert.deepEqual(
    bot.chooseTax(hand, 2, "dalmuti", bot.DIFFICULTY.HARD),
    [12, 11]
  );
  // Easy picks randomly but still returns exactly `count` cards from the hand.
  const picked = bot.chooseTax(hand, 2, "peon", bot.DIFFICULTY.EASY, () => 0.5);
  assert.equal(picked.length, 2);
  for (const card of picked) assert.ok(hand.includes(card));
});

test("difficulty helpers validate the three supported levels", () => {
  assert.deepEqual(bot.DIFFICULTIES.sort(), ["easy", "hard", "medium"]);
  assert.equal(bot.isDifficulty("hard"), true);
  assert.equal(bot.isDifficulty("nope"), false);
  assert.equal(bot.isDifficulty(null), false);
});
