"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  escapeHtml,
  sanitizeNickname,
  sanitizeRoomName,
  sanitizeChat,
  createRateLimiter,
} = require("../server/security");

test("escapeHtml neutralises markup", () => {
  assert.equal(escapeHtml('<img src=x onerror=alert(1)>'), "&lt;img src=x onerror=alert(1)&gt;");
  assert.equal(escapeHtml("a & b"), "a &amp; b");
  assert.equal(escapeHtml('"quoted"'), "&quot;quoted&quot;");
});

test("sanitizeNickname strips markup and enforces length", () => {
  assert.equal(sanitizeNickname("<b>Bob</b>"), "Bob");
  assert.equal(sanitizeNickname("Alice"), "Alice");
  assert.equal(sanitizeNickname(""), null);
  assert.equal(sanitizeNickname("   "), null);
  assert.equal(sanitizeNickname("x".repeat(21)), null);
  assert.equal(sanitizeNickname(42), null);
  assert.equal(sanitizeNickname('<script>alert(1)</script>'), "alert(1)");
  assert.equal(sanitizeNickname('"><img src=x>'), null, "pure markup reduces to nothing");
});

test("sanitizeRoomName only allows word characters, spaces and hyphens", () => {
  assert.equal(sanitizeRoomName("My Room-1"), "My Room-1");
  assert.equal(sanitizeRoomName("<script>"), "script");
  assert.equal(sanitizeRoomName("../../etc"), "etc");
  assert.equal(sanitizeRoomName(""), null);
  assert.equal(sanitizeRoomName("x".repeat(25)), null);
});

test("sanitizeChat rejects markup and bounds length", () => {
  assert.equal(sanitizeChat("hello world"), "hello world");
  assert.equal(sanitizeChat("<b>hi</b>"), null);
  assert.equal(sanitizeChat(""), null);
  assert.equal(sanitizeChat("x".repeat(301)), null);
});

test("rate limiter blocks beyond the limit within the window", () => {
  const allow = createRateLimiter({ limit: 3, windowMs: 1000 });
  const t = 1000;
  assert.equal(allow("a", t), true);
  assert.equal(allow("a", t), true);
  assert.equal(allow("a", t), true);
  assert.equal(allow("a", t), false);
  assert.equal(allow("b", t), true);
  assert.equal(allow("a", t + 1001), true, "window resets");
});
