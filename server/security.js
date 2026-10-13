"use strict";

// Input sanitisation, bounds checking and simple rate limiting. Everything that
// reaches the game from a client passes through here first.

const HTML_ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
  "`": "&#96;",
};

function escapeHtml(value) {
  return String(value).replace(/[&<>"'`]/g, (ch) => HTML_ESCAPES[ch]);
}

// Nicknames are rendered in other players' browsers, so strip anything that
// could be markup and cap the length.
function sanitizeNickname(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw
    .replace(/<[^>]*>/g, "")
    .replace(/[<>"'`&]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (trimmed.length < 1 || trimmed.length > 20) return null;
  return trimmed;
}

function sanitizeRoomName(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.replace(/[^\w \-]/g, "").trim();
  if (trimmed.length < 1 || trimmed.length > 24) return null;
  return trimmed;
}

function sanitizeChat(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length < 1 || trimmed.length > 300) return null;
  if (/<[^>]*>/.test(trimmed)) return null; // reject markup outright
  return trimmed;
}

// Target score for a session. A positive whole number, defaulting to 15 and
// capped so a session cannot be made unwinnable by an absurd value. Any invalid
// input (missing field from an older client, NaN, a negative number) falls back
// to the default rather than rejecting the room.
function sanitizeTargetPoints(raw, fallback = 15, min = 1, max = 500) {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.min(n, max);
}

// Fixed-window rate limiter keyed by an arbitrary id (socket id, ip, ...).
function createRateLimiter({ limit, windowMs }) {
  const hits = new Map();
  return function allow(key, now = Date.now()) {
    const entry = hits.get(key);
    if (!entry || now - entry.start >= windowMs) {
      hits.set(key, { start: now, count: 1 });
      return true;
    }
    if (entry.count >= limit) return false;
    entry.count++;
    return true;
  };
}

module.exports = {
  escapeHtml,
  sanitizeNickname,
  sanitizeRoomName,
  sanitizeChat,
  sanitizeTargetPoints,
  createRateLimiter,
};
