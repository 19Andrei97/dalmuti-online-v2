"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const bot = require("../server/bot");
const engine = require("../server/game-engine");
const { JOKER } = engine;

test("enumeratePlays only returns legal plays for the current field", () => {
  const hand = [3, 3, 5, 13];
  // Leading: singles and doubles of every rank, plus the lone-Joker fallback.
  const leads = bot.enumeratePlays(hand, null);
  for (const play of leads) assert.equal(engine.checkRule(null, play), true, JSON.stringify(play));
  assert.ok(leads.some((p) => p[3] === 2), "double 3 available");
  assert.ok(
    !leads.some((p) => p[JOKER] === 1 && Object.keys(p).length === 1),
    "a lone Joker is not offered while a real card can lead"
  );
  // A Joker standing in for a rank (a wild) is still offered while leading.
  assert.ok(leads.some((p) => p[3] === 2 && p[JOKER] === 1), "a Joker can wild a set");
  // When only Jokers remain, the lone-Joker lead is the only legal option.
  assert.ok(
    bot.enumeratePlays([13], null).some((p) => p[JOKER] === 1),
    "a lone Joker is led when nothing else can be"
  );

  // Following a double: the best (fewest-wild) set for each rank that beats it.
  const following = bot.enumeratePlays(hand, { num: 6, count: 2 });
  assert.ok(following.length > 0);
  for (const play of following) {
    assert.equal(engine.checkRule({ num: 6, count: 2 }, play), true, JSON.stringify(play));
    assert.equal(engine.selectionCount(play), 2);
  }
  assert.ok(following.some((p) => p[3] === 2), "a plain pair of 3s beats a pair of 6s");
  // Holding only one 5, the Joker fills out the pair rather than being wasted on
  // a rank the bot already holds two of.
  assert.ok(following.some((p) => p[5] === 1 && p[JOKER] === 1), "5 + Joker pair");
  assert.ok(!following.some((p) => p[3] === 1 && p[JOKER] === 1), "no needless wild");
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

test("enumeratePlays offers full set leads and every legal follow size", () => {
  // Leading with four 9s: every set size 1..4 is a legal lead.
  const leads = bot.enumeratePlays([9, 9, 9, 9], null);
  for (let n = 1; n <= 4; n++) assert.ok(leads.some((p) => p[9] === n), `lead of ${n}`);
  // Following a three-card field: a three-card set is now offered. This used to
  // be impossible - the bot could never answer a 3+ card field.
  const follows = bot.enumeratePlays([4, 4, 4, 7], { num: 6, count: 3 });
  assert.ok(follows.some((p) => p[4] === 3));
  for (const play of follows) {
    assert.equal(engine.checkRule({ num: 6, count: 3 }, play), true, JSON.stringify(play));
    assert.equal(engine.selectionCount(play), 3);
  }
});

test("hard bots answer a three-card field instead of passing", () => {
  const play = bot.choosePlay([4, 4, 4, 7], { num: 6, count: 3 }, bot.DIFFICULTY.HARD);
  assert.deepEqual(play, { 4: 3 });
});

test("hard bots dump their biggest set when they hold the lead", () => {
  // Four 9s go out in a single lead; nothing else is close.
  const hand = [2, 2, 9, 9, 9, 9];
  const play = bot.choosePlay(hand, null, bot.DIFFICULTY.HARD);
  assert.deepEqual(play, { 9: 4 });
});

test("hard bots lead their biggest set rather than a lone low card", () => {
  // The low single (2) can still win a trick later; the big high set is the
  // right lead because it sheds the most and is hardest to beat.
  const hand = [2, 8, 8, 8];
  const play = bot.choosePlay(hand, null, bot.DIFFICULTY.HARD);
  assert.deepEqual(play, { 8: 3 });
});

test("bots lead a lone Joker only when nothing better can be led", () => {
  // A hand of only Jokers must lead one (the rules allow it).
  assert.deepEqual(
    bot.choosePlay([JOKER], null, bot.DIFFICULTY.HARD),
    { [JOKER]: 1 }
  );
  // With a real card available, the Joker is kept back.
  const hand = [4, 4, 4, 9, JOKER];
  const play = bot.choosePlay(hand, null, bot.DIFFICULTY.HARD);
  assert.deepEqual(play, { 4: 3 }, "the Joker is not wasted on a lead");
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
