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
function enumeratePlays(hand, last) {
  const counts = engine.handToCounts(hand);
  const unique = Object.keys(counts).map(Number).sort((a, b) => a - b);
  const candidates = [];

  if (!last) {
    for (const card of unique) candidates.push({ [card]: 1 });
    for (const card of unique) if (counts[card] >= 2) candidates.push({ [card]: 2 });
  } else if (last.count === 1) {
    for (const card of unique) candidates.push({ [card]: 1 });
  } else if (last.count === 2) {
    for (const card of unique) if (counts[card] >= 2) candidates.push({ [card]: 2 });
    if (counts[engine.JOKER] >= 1) {
      for (const card of unique) {
        if (card !== engine.JOKER) candidates.push({ [card]: 1, [engine.JOKER]: 1 });
      }
    }
  }

  return candidates.filter((sel) => engine.checkRule(last, sel));
}

function chooseRandom(plays, rng) {
  const idx = Math.floor(rng() * plays.length);
  return plays[Math.min(idx, plays.length - 1)];
}

// Easy: plays at random and may waste strong cards or Jokers.
function chooseEasy(hand, last, rng) {
  const plays = enumeratePlays(hand, last);
  if (!plays.length) return null;
  return chooseRandom(plays, rng);
}

// Medium: sheds the most valuable (worst) cards it legally can, but does not
// plan ahead - it may spend a Joker to dump a high card.
function chooseMedium(hand, last) {
  const plays = enumeratePlays(hand, last);
  if (!plays.length) return null;
  let best = plays[0];
  for (const play of plays) {
    if (selectionValue(play) > selectionValue(best)) best = play;
  }
  return best;
}

// Hard: wins when it can, otherwise preserves Jokers (its only wildcards) and
// sheds the worst legal cards.
function chooseHard(hand, last) {
  const plays = enumeratePlays(hand, last);
  if (!plays.length) return null;
  const score = (play) => {
    let s = selectionValue(play);
    if (selectionCards(play).length === hand.length) s += 10000;
    if (containsJoker(play)) s -= 500;
    return s;
  };
  let best = plays[0];
  for (const play of plays) {
    if (score(play) > score(best)) best = play;
  }
  return best;
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
