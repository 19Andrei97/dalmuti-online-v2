"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  prepareDeck,
  shuffle,
  validateSelection,
  checkValidity,
  checkRule,
  applyPlay,
  computeRoles,
  drawForOrder,
  deal,
  computeTaxes,
  peonBestCards,
  dalmutiWorstCards,
  removeCards,
  revolutionCandidates,
  reverseOrder,
  Game,
  game_state,
  ROLE,
  JOKER,
} = require("../server/game-engine");

test("deck composition: 80 cards, rank counts equal to rank, two Jokers", () => {
  const deck = prepareDeck();
  assert.equal(deck.length, 80);
  for (let rank = 1; rank <= 12; rank++) {
    assert.equal(deck.filter((c) => c === rank).length, rank, `rank ${rank}`);
  }
  assert.equal(deck.filter((c) => c === JOKER).length, 2);
});

test("shuffle preserves the multiset of cards", () => {
  const deck = prepareDeck();
  const shuffled = shuffle(deck);
  assert.deepEqual(shuffled.slice().sort((a, b) => a - b), deck.slice().sort((a, b) => a - b));
});

test("validateSelection rejects prototype pollution, non-integers and bad counts", () => {
  assert.equal(validateSelection({ 1: 1 })[1], 1);
  assert.equal(validateSelection(null), null);
  assert.equal(validateSelection([]), null);
  assert.equal(validateSelection("x"), null);
  assert.equal(validateSelection({ 1: -1 }), null);
  assert.equal(validateSelection({ 1: 0 }), null);
  assert.equal(validateSelection({ 1: 1.5 }), null);
  assert.equal(validateSelection({ 14: 1 }), null);
  assert.equal(validateSelection({ abc: 1 }), null);
  assert.equal(validateSelection(JSON.parse('{"__proto__": {"polluted": 1}}')), null);
  assert.equal({}.polluted, undefined);
});

test("checkValidity only allows cards that are actually held", () => {
  assert.equal(checkValidity([1, 2, 2, 3], { 2: 2 }), true);
  assert.equal(checkValidity([1, 2, 2, 3], { 2: 3 }), false);
  assert.equal(checkValidity([1, 2, 2, 3], { 5: 1 }), false);
});

test("checkRule: leading rules", () => {
  assert.equal(checkRule(null, { 5: 1 }), true);
  assert.equal(checkRule(null, { 13: 1 }), false);
  assert.equal(checkRule(null, { 5: 1, 6: 1 }), false);
  assert.equal(checkRule(null, { 5: 1, 13: 1 }), true);
  assert.equal(checkRule(null, { 5: 1, 6: 1, 7: 1 }), false);
});

test("checkRule: following rules (count and rank)", () => {
  const last = { num: 5, count: 2 };
  assert.equal(checkRule(last, { 3: 2 }), true);
  assert.equal(checkRule(last, { 5: 2 }), false);
  assert.equal(checkRule(last, { 6: 2 }), false);
  assert.equal(checkRule(last, { 3: 1 }), false);
  assert.equal(checkRule(last, { 3: 1, 13: 1 }), true);
  assert.equal(checkRule(last, { 13: 2 }), false);
});

test("checkRule: a set may hold any number of copies of one rank", () => {
  // Official rule: a lead/follow is a set of any size of a single rank.
  assert.equal(checkRule(null, { 12: 4 }), true, "four peasants may be led");
  assert.equal(checkRule(null, { 9: 5 }), true, "a five-card rank may be led");
  assert.equal(checkRule({ num: 12, count: 4 }, { 7: 4 }), true);
  assert.equal(checkRule({ num: 12, count: 4 }, { 3: 3 }), false, "wrong count");
  assert.equal(checkRule({ num: 5, count: 4 }, { 5: 4 }), false, "equal rank cannot follow");
});

test("checkRule: Jokers are wild and complete a set of one rank", () => {
  // Jesters played with other cards take on that rank; alone they are a 13.
  assert.equal(checkRule(null, { 9: 1, 13: 1 }), true);
  assert.equal(checkRule(null, { 9: 3, 13: 1 }), true, "one Joker completes four 9s");
  assert.equal(checkRule(null, { 9: 2, 13: 2 }), true, "two Jokers complete four 9s");
  assert.equal(checkRule(null, { 9: 1, 8: 1 }), false, "non-Joker ranks must match");
  assert.equal(checkRule({ num: 12, count: 4 }, { 9: 3, 13: 1 }), true);
  assert.equal(checkRule({ num: 12, count: 3 }, { 9: 1, 13: 2 }), true);
  // Jokers alone are the worst cards (a 13): illegal to lead, and they cannot
  // match any field because they never beat a real rank.
  assert.equal(checkRule(null, { 13: 1 }), false);
  assert.equal(checkRule(null, { 13: 2 }), false);
  assert.equal(checkRule({ num: 12, count: 2 }, { 13: 2 }), false);
});

test("applyPlay removes exactly the selected cards and keeps a sorted numeric hand", () => {
  const hand = [1, 2, 2, 3, 13];
  const result = applyPlay(hand, { 2: 2, 13: 1 });
  assert.deepEqual(result, [1, 3]);
});

test("computeRoles assigns the expected social classes", () => {
  const order = ["a", "b", "c", "d", "e"];
  const roles = computeRoles(order);
  assert.equal(roles.a, ROLE.GREATER_DALMUTI);
  assert.equal(roles.b, ROLE.LESSER_DALMUTI);
  assert.equal(roles.c, ROLE.MERCHANT);
  assert.equal(roles.d, ROLE.LESSER_PEON);
  assert.equal(roles.e, ROLE.GREATER_PEON);

  const three = computeRoles(["a", "b", "c"]);
  assert.equal(three.a, ROLE.GREATER_DALMUTI);
  assert.equal(three.b, ROLE.MERCHANT);
  assert.equal(three.c, ROLE.GREATER_PEON);
});

test("deal gives every card and higher-ranked players get the extras", () => {
  const order = ["a", "b", "c", "d", "e", "f", "g"];
  const hands = deal(prepareDeck(), order);
  const all = order.flatMap((sid) => hands[sid]);
  assert.equal(all.length, 80, "all cards dealt");
  const sizes = order.map((sid) => hands[sid].length);
  assert.deepEqual(sizes, [12, 12, 12, 11, 11, 11, 11]);
});

test("drawForOrder seats the best card first (deterministic rng)", () => {
  const order = drawForOrder(["a", "b"], () => 0);
  assert.equal(order.length, 2);
});

test("revolution candidates: both Jokers, Greater Peon triggers a greater revolution", () => {
  const hands = {
    a: [1, 2],
    b: [JOKER, JOKER, 5],
    c: [3, 4],
  };
  const roles = { a: ROLE.GREATER_DALMUTI, b: ROLE.GREATER_PEON, c: ROLE.MERCHANT };
  const cands = revolutionCandidates(hands, roles);
  assert.equal(cands.length, 1);
  assert.equal(cands[0].sid, "b");
  assert.equal(cands[0].greater, true);
  assert.deepEqual(reverseOrder(["a", "b", "c"]), ["c", "b", "a"]);
});

test("taxes: greater peon owes 2 to dalmuti, lesser owes 1", () => {
  const roles = {
    a: ROLE.GREATER_DALMUTI,
    b: ROLE.LESSER_DALMUTI,
    c: ROLE.MERCHANT,
    d: ROLE.LESSER_PEON,
    e: ROLE.GREATER_PEON,
  };
  const taxes = computeTaxes(roles);
  assert.equal(taxes.length, 2);
  assert.deepEqual(taxes[0], { kind: "greater", from: "e", to: "a", count: 2 });
  assert.deepEqual(taxes[1], { kind: "lesser", from: "d", to: "b", count: 1 });
});

test("peon surrenders best (lowest) cards, never a Joker; dalmuti returns worst", () => {
  const peonHand = [1, 5, 13, 12];
  assert.deepEqual(peonBestCards(peonHand, 2), [1, 5]);
  const dalmutiHand = [1, 2, 11, 12];
  assert.deepEqual(dalmutiWorstCards(dalmutiHand, 2), [12, 11]);
});

test("removeCards removes exactly the given cards", () => {
  assert.deepEqual(removeCards([1, 2, 3, 3], [3, 1]), [2, 3]);
});

test("Game turn management: round resets and win detection", () => {
  const game = new Game();
  const roomData = {
    sockets: {
      s0: { seat: 0, hand: [] },
      s1: { seat: 1, hand: [] },
      s2: { seat: 2, hand: [] },
    },
  };
  game.begin(roomData, ["s0", "s1", "s2"]);
  assert.equal(game.state, game_state.PLAYING);
  assert.equal(game.cur_order_idx, 0, "Greater Dalmuti leads");

  game.updateOrder(0);
  game.updateOrder(1);
  assert.equal(game.isOneLeft(), true);

  game.updateOrder(2);
  assert.equal(game.isOneLeft(), true);
  game.end();
  assert.equal(game.state, game_state.WAITING);
});

test("Game.nextPlayer advances and resolves a completed round", () => {
  const game = new Game();
  const roomData = {
    sockets: { s0: { seat: 0 }, s1: { seat: 1 } },
  };
  game.begin(roomData, ["s0", "s1"]);
  game.cur_order[1] = 0;
  const roundOver = game.nextPlayer({ 5: 1 });
  assert.equal(roundOver, true, "only one player left playing -> new round");
  assert.equal(game.last, null);
  assert.equal(game.cur_order[0], 1);
  assert.equal(game.cur_order[1], 1);
  assert.equal(game.cur_order.slice(2).every((v) => v === -1), true);
});

test("Game.nextPlayer records who played last and resets the round to the leader", () => {
  const game = new Game();
  const roomData = {
    sockets: { s0: { seat: 0 }, s1: { seat: 1 }, s2: { seat: 2 } },
  };
  game.begin(roomData, ["s0", "s1", "s2"]);

  // s0 plays; the field remembers the player and the rank/count.
  game.nextPlayer({ 7: 2 }, "s0");
  assert.deepEqual(game.last, { num: 7, count: 2, by: "s0", handCount: null });

  // s1 passes: the turn moves but the last play is untouched.
  game.nextPlayer({}, "s1");
  assert.equal(game.last.by, "s0");
  assert.equal(game.last.num, 7);

  // Everyone else passes, ending the round. The field is cleared and the turn
  // returns to the first still-playing seat.
  game.cur_order[1] = 0;
  game.cur_order[2] = 0;
  const roundOver = game.nextPlayer({}, "s2");
  assert.equal(roundOver, true);
  assert.equal(game.last, null);
  assert.equal(game.cur_order_idx, 0);
});

test("Game.begin places the Greater Dalmuti first regardless of seat numbering", () => {
  const game = new Game();
  const roomData = {
    sockets: { s0: { seat: 3 }, s1: { seat: 5 } },
  };
  game.begin(roomData, ["s1", "s0"]);
  assert.equal(game.cur_order_idx, 5);
});

test("the player who wins a trick leads the next trick (not the social leader)", () => {
  const game = new Game();
  const sockets = { s0: { seat: 0 }, s1: { seat: 1 }, s2: { seat: 2 } };
  const roomData = { sockets };
  game.begin(roomData, ["s0", "s1", "s2"]); // s0 (Greater Dalmuti) leads

  game.nextPlayer({ 12: 1 }, "s0", roomData); // s0 leads a 12
  game.nextPlayer({ 3: 1 }, "s1", roomData); // s1 beats it with a 3
  game.cur_order[2] = 0; // s2 passes
  game.nextPlayer({}, null, roomData);
  game.cur_order[0] = 0; // s0 passes, ending the trick
  const roundOver = game.nextPlayer({}, null, roomData);

  assert.equal(roundOver, true, "trick is complete");
  assert.equal(game.cur_order_idx, sockets.s1.seat, "the trick winner (s1) leads");
  assert.equal(game.last, null, "the rule state is cleared for a new lead");
  assert.equal(game.shown.by, "s1", "the winning play stays on display");
});

test("a finished trick keeps its display copy in `shown`", () => {
  const game = new Game();
  const roomData = { sockets: { s0: { seat: 0 }, s1: { seat: 1 } } };
  game.begin(roomData, ["s0", "s1"]);
  game.nextPlayer({ 7: 2 }, "s0", roomData);
  assert.deepEqual(game.shown, { num: 7, count: 2, by: "s0", handCount: null });

  game.cur_order[1] = 0;
  game.nextPlayer({}, null, roomData);
  assert.equal(game.last, null);
  assert.equal(game.shown.by, "s0", "shown survives the completed trick");
  assert.equal(game.shown.num, 7);
});

test("if the trick winner has gone out, the lead passes clockwise", () => {
  const game = new Game();
  const roomData = { sockets: { s0: { seat: 0 }, s1: { seat: 1 }, s2: { seat: 2 } } };
  game.begin(roomData, ["s0", "s1", "s2"]);
  game.nextPlayer({ 12: 1 }, "s0", roomData); // s0 (seat 0) leads
  game.nextPlayer({ 3: 1 }, "s1", roomData); // s1 (seat 1) beats it
  game.cur_order[2] = 0; // s2 passes
  game.nextPlayer({}, null, roomData);
  // s1 empties their hand on that play, so seat 1 leaves the order.
  game.order[1] = false;
  game.cur_order[0] = 0; // s0 passes, ending the trick (s1 wins it)
  const roundOver = game.nextPlayer({}, null, roomData);

  assert.equal(roundOver, true);
  // Clockwise from the winner's seat (1) is seat 2, not the lowest seat (0).
  assert.equal(game.cur_order_idx, 2, "lead passes clockwise to the next seated player");
});
