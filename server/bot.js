"use strict";

// Bot decision logic. Pure functions: given a hand, the current field and a
// difficulty, they return a legal move (or null to pass) / tax cards. No
// transport or room state lives here so the strategies stay unit-testable.

const engine = require("./game-engine");

const DIFFICULTY = { EASY: "easy", MEDIUM: "medium", HARD: "hard" };
const DIFFICULTIES = Object.values(DIFFICULTY);

function isDifficulty(value) {
  return DIFFICULTIES.includes(value);
}

function selectionCards(selection) {
  const cards = [];
  for (const [card, count] of Object.entries(selection)) {
    for (let i = 0; i < count; i++) cards.push(Number(card));
  }
  return cards;
}

function selectionValue(selection) {
  let total = 0;
  for (const [card, count] of Object.entries(selection)) total += Number(card) * count;
  return total;
}

function containsJoker(selection) {
  return !!selection[engine.JOKER];
}

// Every legal play available to `hand` against the field `last` (or when
// leading, when last is null), as {card: count} maps. Candidates are filtered
// through the engine's rule check so the list can never contain an illegal play.
//
// A set may hold any number of copies of a single rank, and each Joker played
// beside a real rank stands in for it, so both leading and following enumerate
// every set size (a 4-of-a-kind lead or a 3-card follow are real options, not
// just singles and pairs).
function enumeratePlays(hand, last) {
  const counts = engine.handToCounts(hand);
  const unique = Object.keys(counts).map(Number).sort((a, b) => a - b);
  const jokers = counts[engine.JOKER] || 0;
  const candidates = [];

  if (!last) {
    for (const card of unique) {
      if (card === engine.JOKER) continue;
      // A run of 1..all copies of the rank, optionally enlarged with wilds.
      for (let n = 1; n <= counts[card]; n++) candidates.push({ [card]: n });
      for (let w = 1; w <= jokers; w++) {
        candidates.push({ [card]: counts[card], [engine.JOKER]: w });
      }
    }
    // A lone Joker is a rank-13 lead; a Joker pair is a rank-13 pair.
    for (let n = 1; n <= jokers; n++) candidates.push({ [engine.JOKER]: n });
  } else {
    const n = last.count;
    for (const card of unique) {
      if (card === engine.JOKER) continue;
      const need = n - counts[card];
      if (need <= 0) candidates.push({ [card]: n });
      else if (jokers >= need) candidates.push({ [card]: counts[card], [engine.JOKER]: need });
    }
    if (jokers >= n) candidates.push({ [engine.JOKER]: n });
  }

  const plays = candidates.filter((sel) => engine.checkRule(last, sel));
  // A lone Joker (or a Joker pair) is a legal but weak play. Bots only fall back
  // to it when nothing better exists, so they never throw a wildcard away
  // needlessly. Joker-with-a-rank plays are kept: those are the useful wilds.
  const nonJokerOnly = plays.filter(
    (sel) => !Object.keys(sel).every((card) => Number(card) === engine.JOKER)
  );
  return nonJokerOnly.length ? nonJokerOnly : plays;
}

function chooseRandom(plays, rng) {
  const idx = Math.floor(rng() * plays.length);
  return plays[Math.min(idx, plays.length - 1)];
}

function bestByScore(plays, score) {
  let best = plays[0];
  let bestScore = score(best);
  for (const play of plays) {
    const s = score(play);
    if (s > bestScore) {
      best = play;
      bestScore = s;
    }
  }
  return best;
}

// Easy: plays at random and may waste strong cards or Jokers.
function chooseEasy(hand, last, rng) {
  const plays = enumeratePlays(hand, last);
  if (!plays.length) return null;
  return chooseRandom(plays, rng);
}

// Medium: sheds as many cards as it legally can, preferring the worst (highest)
// ones, but does not plan ahead - it may spend a Joker to dump a high card.
function chooseMedium(hand, last) {
  const plays = enumeratePlays(hand, last);
  if (!plays.length) return null;
  const score = (play) => selectionValue(play) + selectionCards(play).length * 40;
  return bestByScore(plays, score);
}

// Hard: the researched strategy. It wins the hand when it can, dumps as many of
// its worst (highest) cards as possible, prefers the biggest set it can play
// (which both sheds more and is harder to beat, keeping the lead), and treats a
// Joker as too valuable to spend unless that is the only legal way to follow.
function chooseHard(hand, last) {
  const plays = enumeratePlays(hand, last);
  if (!plays.length) return null;

  const score = (play) => {
    const n = selectionCards(play).length;
    let s = selectionValue(play); // shed the worst cards first
    s += n * 60; // and shed as many as possible
    if (n === hand.length) s += 100000; // going out wins the hand
    if (containsJoker(play)) s -= 1000; // wilds are far too valuable to spend
    return s;
  };

  return bestByScore(plays, score);
}

// Pick a move for the given difficulty. Returns a selection map or null (pass).
function choosePlay(hand, last, difficulty, rng = Math.random) {
  switch (difficulty) {
    case DIFFICULTY.EASY:
      return chooseEasy(hand, last, rng);
    case DIFFICULTY.HARD:
      return chooseHard(hand, last);
    case DIFFICULTY.MEDIUM:
    default:
      return chooseMedium(hand, last);
  }
}

// Pick `count` cards to hand over during taxation. Peons give their best
// (lowest) cards, Dalmutis return their worst (highest); easy picks at random.
function chooseTax(hand, count, role, difficulty, rng = Math.random) {
  if (difficulty === DIFFICULTY.EASY) {
    const pool = hand.slice();
    const out = [];
    for (let i = 0; i < count && pool.length; i++) {
      const idx = Math.floor(rng() * pool.length);
      out.push(pool.splice(idx, 1)[0]);
    }
    return out;
  }
  return role === "peon" ? engine.peonBestCards(hand, count) : engine.dalmutiWorstCards(hand, count);
}

module.exports = {
  DIFFICULTY,
  DIFFICULTIES,
  isDifficulty,
  enumeratePlays,
  selectionCards,
  choosePlay,
  chooseTax,
};
