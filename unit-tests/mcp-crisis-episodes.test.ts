import test from "node:test";
import assert from "node:assert/strict";
import {
  CRISIS_EPISODES,
  episodesForRange,
  warmUpStartForEpisode,
} from "@/lib/mcp/crisis-episodes";

test("the catalog is ordered, non-overlapping, and internally consistent", () => {
  for (const e of CRISIS_EPISODES) {
    assert.ok(e.startDate < e.endDate, `${e.name}: ${e.startDate} is not before ${e.endDate}`);
    assert.ok(e.name.length > 0);
    assert.ok(e.description.length > 0, `${e.name} has no description`);
  }
  for (let i = 1; i < CRISIS_EPISODES.length; i += 1) {
    assert.ok(
      CRISIS_EPISODES[i - 1].endDate <= CRISIS_EPISODES[i].startDate,
      `${CRISIS_EPISODES[i - 1].name} overlaps ${CRISIS_EPISODES[i].name}`,
    );
  }
});

test("episodesForRange keeps only episodes fully inside the available data", () => {
  // The Nasdaq series starts 1971-02-05 (the NDQ-TR composite proxy), so 1929
  // is out of reach but the 1973-74 bear is genuinely covered.
  const nasdaq = episodesForRange("1971-02-05", "2026-01-01");
  assert.equal(nasdaq.some((e) => e.startDate.startsWith("1929")), false);
  assert.equal(nasdaq.some((e) => e.startDate.startsWith("1907")), false);
  assert.ok(nasdaq.some((e) => e.startDate.startsWith("1973")), "1973-74 is in Nasdaq range");
  assert.ok(nasdaq.some((e) => e.name.includes("Global Financial")));

  const full = episodesForRange("1885-03-20", "2026-01-01");
  assert.ok(full.length > nasdaq.length, "a longer history covers more episodes");
  assert.ok(full.some((e) => e.startDate.startsWith("1929")));
});

test("episodesForRange excludes an episode whose end runs past the data", () => {
  const truncated = episodesForRange("1885-01-01", "2008-01-01");
  // The GFC episode ends in 2009, so a range stopping in 2008 must drop it
  // rather than reporting a partial crisis as a whole one.
  assert.equal(truncated.some((e) => e.name.includes("Global Financial")), false);
});

test("episodesForRange returns nothing when no episode fits", () => {
  assert.deepEqual(episodesForRange("2023-01-01", "2024-01-01"), []);
});

test("warmUpStartForEpisode backs up far enough to seed the SMA", () => {
  const warmUp = warmUpStartForEpisode("2008-01-01", 200);
  assert.ok(warmUp < "2008-01-01", "warm-up must start before the episode");
  // 200 trading days is roughly 10 calendar months; allow generous slack but
  // require it to be more than a token offset.
  assert.ok(warmUp < "2007-06-01", `${warmUp} is not enough warm-up for a 200-day SMA`);
});

test("warmUpStartForEpisode with no SMA does not move the start", () => {
  assert.equal(warmUpStartForEpisode("2008-01-01", 0), "2008-01-01");
});
