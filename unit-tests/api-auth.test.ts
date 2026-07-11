import test from "node:test";
import assert from "node:assert/strict";
import { timingSafeStringEqual } from "../src/lib/api/auth";

test("timingSafeStringEqual matches identical strings", () => {
  assert.equal(timingSafeStringEqual("Bearer secret-123", "Bearer secret-123"), true);
  assert.equal(timingSafeStringEqual("", ""), true);
});

test("timingSafeStringEqual rejects different strings of equal length", () => {
  assert.equal(timingSafeStringEqual("Bearer secret-123", "Bearer secret-124"), false);
});

test("timingSafeStringEqual rejects different lengths", () => {
  assert.equal(timingSafeStringEqual("Bearer secret", "Bearer secret-123"), false);
  assert.equal(timingSafeStringEqual("Bearer secret-123", ""), false);
});

test("timingSafeStringEqual handles null and undefined candidates", () => {
  assert.equal(timingSafeStringEqual(null, "Bearer secret"), false);
  assert.equal(timingSafeStringEqual(undefined, "Bearer secret"), false);
});

test("timingSafeStringEqual compares multi-byte strings by content", () => {
  assert.equal(timingSafeStringEqual("clé-秘密", "clé-秘密"), true);
  assert.equal(timingSafeStringEqual("clé-秘密", "clé-秘蜜"), false);
});
