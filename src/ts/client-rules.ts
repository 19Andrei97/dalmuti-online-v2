import { JOKER, type CardSelection, type LastPlay } from "./types";

/* Client-side mirror of server/game-engine.js checkRule, used only to enable the
 * Play button and to explain an invalid pick. The server remains the authority;
 * this never blocks a move the server would accept. */

export function selectionRanks(selection: CardSelection): number[] {
  return Object.keys(selection).map(Number);
}

export function selectionTotal(selection: CardSelection): number {
  let sum = 0;
  for (const count of Object.values(selection)) sum += count;
  return sum;
}

/** True when the selection could legally be led (table empty). */
export function canLead(selection: CardSelection): boolean {
  const ranks = selectionRanks(selection);
  if (ranks.length === 0) return false;
  if (ranks.length > 2) return false;
  if (ranks.length === 2 && !selection[JOKER]) return false;
  if (ranks.length === 1 && ranks[0] === JOKER) return false;
  return true;
}

/** True when the selection legally follows the cards currently on the table. */
export function followsField(last: LastPlay, selection: CardSelection): boolean {
  const ranks = selectionRanks(selection);
  if (ranks.length === 0) return false;
  if (ranks.length > 2) return false;
  if (ranks.length === 2 && !selection[JOKER]) return false;
  if (selectionTotal(selection) !== last.count) return false;

  for (const rank of ranks) {
    if (ranks.length === 1) {
      if (rank === JOKER) return false;
      if (last.num - rank <= 0) return false;
    } else if (rank !== JOKER) {
      if (last.num - rank <= 0) return false;
    }
  }
  return true;
}

export type MoveKind = "pass" | "play" | "invalid";

/** Classify a button press: play a selection, pass, or reject it. */
export function classifyMove(
  last: LastPlay | null,
  selection: CardSelection,
  tableEmpty: boolean
): MoveKind {
  if (selectionTotal(selection) === 0) return tableEmpty ? "invalid" : "pass";
  if (tableEmpty) return canLead(selection) ? "play" : "invalid";
  return followsField(last ?? { num: 0, count: 0, by: "" }, selection) ? "play" : "invalid";
}

/** Number of cards the field demands, or 0 when leading. */
export function fieldCount(last: LastPlay | null): number {
  return last && last.num ? last.count : 0;
}

/**
 * The ranks that could ever take part in a legal play for the given field, or
 * `null` when there is no hint to give (the table is empty and almost anything
 * may be led). Used only to dim the hand; the server stays the authority.
 *
 * A legal follow is either one non-Joker card, or the pair {Joker, lower rank},
 * and its total must equal the field's count. So every rank below the field's
 * rank can answer; the Joker can only answer a *two*-card field (a Joker pair is
 * two cards and can never match a one- or three-card field). The field count does
 * not otherwise restrict which ranks are playable.
 */
export function playableRanks(last: LastPlay | null, tableEmpty: boolean): Set<number> | null {
  if (tableEmpty || !last) return null;

  const playable = new Set<number>();
  for (let rank = 1; rank < JOKER; rank++) {
    if (last.num - rank > 0) playable.add(rank);
  }
  if (last.count === 2 && last.num > 1) playable.add(JOKER);
  return playable;
}
