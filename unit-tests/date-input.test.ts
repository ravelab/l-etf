import test from "node:test";
import assert from "node:assert/strict";
import {
  formatDateDraft,
  parseDateInput,
  toDisplayDate,
  countDigits,
  caretForDigit,
} from "@/lib/date-input";

test("formatDateDraft progressively inserts slashes as digits are typed", () => {
  assert.equal(formatDateDraft(""), "");
  assert.equal(formatDateDraft("2"), "2");
  assert.equal(formatDateDraft("2010"), "2010");
  assert.equal(formatDateDraft("20100"), "2010/0");
  assert.equal(formatDateDraft("201002"), "2010/02");
  assert.equal(formatDateDraft("2010021"), "2010/02/1");
  assert.equal(formatDateDraft("20100212"), "2010/02/12");
});

test("formatDateDraft drops digits beyond eight and ignores existing separators", () => {
  assert.equal(formatDateDraft("2010021299"), "2010/02/12");
  assert.equal(formatDateDraft("2010/02/12"), "2010/02/12");
  assert.equal(formatDateDraft("2010-02-12"), "2010/02/12");
  // partial re-edit: a user deleting back to the month keeps the slash
  assert.equal(formatDateDraft("2010/0"), "2010/0");
});

test("parseDateInput accepts bare 8-digit YYYYMMDD entry", () => {
  assert.equal(parseDateInput("20100212"), "2010-02-12");
});

test("parseDateInput accepts slash and dash separators and pads single digits", () => {
  assert.equal(parseDateInput("2010/02/12"), "2010-02-12");
  assert.equal(parseDateInput("2010-02-12"), "2010-02-12");
  assert.equal(parseDateInput("2010/2/5"), "2010-02-05");
  assert.equal(parseDateInput("  2010/02/12  "), "2010-02-12");
});

test("parseDateInput rejects impossible and malformed dates", () => {
  assert.equal(parseDateInput(""), null);
  assert.equal(parseDateInput("abcd"), null);
  assert.equal(parseDateInput("2010/13/01"), null);
  assert.equal(parseDateInput("2010/02/30"), null);
  assert.equal(parseDateInput("201002"), null); // too few digits, no separators
  assert.equal(parseDateInput("2010021"), null);
});

test("toDisplayDate swaps dashes for slashes", () => {
  assert.equal(toDisplayDate("2010-02-12"), "2010/02/12");
  assert.equal(toDisplayDate(""), "");
});

test("countDigits counts digits left of the caret", () => {
  assert.equal(countDigits("2010/02/12", 0), 0);
  assert.equal(countDigits("2010/02/12", 4), 4);
  assert.equal(countDigits("2010/02/12", 5), 4); // caret just after the slash
  assert.equal(countDigits("2010/02/12", 10), 8);
});

test("caretForDigit returns the offset just after the Nth digit", () => {
  assert.equal(caretForDigit("2010/02/12", 0), 0);
  assert.equal(caretForDigit("2010/02/12", 4), 4); // after the year, before slash
  assert.equal(caretForDigit("2010/02/12", 6), 7); // after first month digit
  assert.equal(caretForDigit("2010/02/12", 8), 10);
  assert.equal(caretForDigit("2010/02/12", 99), 10); // clamps to end
});
