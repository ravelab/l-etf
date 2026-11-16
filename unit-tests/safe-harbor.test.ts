import assert from "node:assert/strict";
import { test } from "node:test";
import { SafeHarborTaxes, taxDueDatesBetween } from "../src/lib/simulation/safe-harbor";

const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test("a session settles the due dates since the previous one, on or after each date", () => {
  assert.deepEqual(taxDueDatesBetween("2021-01-14", "2021-01-15"), ["2021-01-15"]);
  assert.deepEqual(taxDueDatesBetween("2021-01-15", "2021-01-19"), []);
  assert.deepEqual(taxDueDatesBetween("2021-04-14", "2021-04-19"), ["2021-04-15"]);
  assert.deepEqual(taxDueDatesBetween("2020-12-31", "2022-01-15"), [
    "2021-01-15", "2021-04-15", "2021-06-15", "2021-09-15", "2022-01-15",
  ]);
});

test("each year pays 110% of the prior year's tax in four installments, settling up in April", () => {
  const taxes = new SafeHarborTaxes();
  // The account's first year: no prior-year tax, so no estimates.
  for (const date of ["2020-04-15", "2020-06-15", "2020-09-15", "2021-01-15"]) near(taxes.due(date), 0);
  taxes.setTax(2020, 100);
  // April 2021: 2020's whole 100, plus the first of four 27.5 installments for 2021.
  near(taxes.due("2021-04-15"), 100 + 27.5);
  near(taxes.due("2021-06-15"), 27.5);
  near(taxes.due("2021-09-15"), 27.5);
  taxes.setTax(2021, 50);
  near(taxes.due("2022-01-15"), 27.5);
  // 2021 paid 110 against a 50 bill: April refunds 60 net of 2022's first 13.75.
  near(taxes.due("2022-04-15"), -60 + 13.75);
  // The account closes in May 2022 owing nothing that year: its 13.75 comes back.
  taxes.setTax(2022, 0);
  near(taxes.outstanding(), -13.75);
});

test("an April true-up settles a year once", () => {
  const taxes = new SafeHarborTaxes();
  taxes.setTax(2020, 40);
  near(taxes.outstanding(), 40);
  near(taxes.due("2021-04-15"), 40 + 11);
  near(taxes.due("2021-04-15") - 11, 0);
});
