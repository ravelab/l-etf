import test from "node:test";
import assert from "node:assert/strict";
import {
  applySizeAdjustedApys,
  buildSizeModel,
  effectiveYieldToApyPercent,
  fitYieldPenaltyBpsPer10xSmallerNotional,
  parseBoxtradesSpxContractPage,
  parseSpxExpiryFormats,
  recentSizeAdjustedYieldPercent,
  sizePremiumBps,
} from "../src/lib/boxtrades";

type SizeObservationFixture = Parameters<typeof buildSizeModel>[0][number];

function buildHtml({
  description = "As of Apr 27, 2026, the average rate was around 4.18%.",
  dte = "600",
  data = [{ rate: 3.9797815220060406, last: 980, volume: 1, ts: 1 }],
}: {
  description?: string;
  dte?: string;
  data?: Array<{
    rate?: number | null;
    last?: number | null;
    volume?: number | null;
    ts?: number | null;
  }>;
} = {}) {
  return `
    <html>
      <body>
        <input type="number" id="dte" value="${dte}" disabled="" />
        <script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
          props: {
            pageProps: {
              description,
              expiry: Date.UTC(2027, 11, 17),
              data,
            },
          },
        })}</script>
      </body>
    </html>
  `;
}

test("effectiveYieldToApyPercent converts simple annualized yield over the contract term", () => {
  const apy = effectiveYieldToApyPercent(4.18, 600);
  assert.equal(Math.round(apy * 10_000) / 10_000, 4.1255);
});

test("parseSpxExpiryFormats extracts unique SPX expiry formats", () => {
  const html = `
    <a href="/SPX/17DEC27">17 Dec 27</a>
    <a href="/SPX/17DEC27">duplicate</a>
    <a href="/SPX/15DEC28">15 Dec 28</a>
    <a href="/EW3Z7/17DEC27">ES</a>
  `;
  assert.deepEqual(parseSpxExpiryFormats(html), ["17DEC27", "15DEC28"]);
});

test("parseBoxtradesSpxContractPage returns Boxtrades yield and APY fields", () => {
  const contract = parseBoxtradesSpxContractPage(buildHtml(), "17DEC27");
  assert.deepEqual(contract, {
    expiry: "2027-12-17",
    expFormat: "17DEC27",
    daysToExpiry: 600,
    asOf: "Apr 27, 2026",
    boxtradesYieldPercent: 4.18,
    apyPercent: 4.1255,
    sizeAdjustedApyPercent: {},
    fidelityAndSpreadAdjustedApyPercent: {},
    sizePremiumVsBenchmarkBps: {},
  });
});

test("parseBoxtradesSpxContractPage tolerates missing Boxtrades yield", () => {
  const contract = parseBoxtradesSpxContractPage(
    buildHtml({
      description: "No chart data available.",
      data: [{ rate: 4.1, last: 980, volume: 1, ts: 1 }],
    }),
    "17DEC27",
  );
  assert.equal(contract.boxtradesYieldPercent, null);
  assert.equal(contract.apyPercent, null);
});

test("fitYieldPenaltyBpsPer10xSmallerNotional estimates smaller-size penalty", () => {
  const observations = Array.from({ length: 40 }, (_, index) => {
    const log10Notional = 4 + index / 10;
    return {
      log10Notional,
      residualYieldPercent: 0.12 - 0.02 * log10Notional,
      receivedAmount: 10 ** log10Notional,
      ageDays: 1,
    };
  });
  assert.ok(
    Math.abs((fitYieldPenaltyBpsPer10xSmallerNotional(observations) ?? 0) - 2) <
      1e-12,
  );
});

test("sizePremiumBps increases for smaller target notionals", () => {
  assert.equal(sizePremiumBps(1.7, 200_000, 1_000_000), 1.2);
  assert.equal(sizePremiumBps(1.7, 50_000, 1_000_000), 2.2);
});

test("sizePremiumBps uses total trade notional, not per-contract size", () => {
  const oneLargeContract = 10_000 * 100 * 1;
  const tenSmallerContracts = 1_000 * 100 * 10;

  assert.equal(oneLargeContract, tenSmallerContracts);
  assert.equal(
    sizePremiumBps(3, oneLargeContract, 1_000_000),
    sizePremiumBps(3, tenSmallerContracts, 1_000_000),
  );
});

test("applySizeAdjustedApys adjusts Boxtrades yield before converting to APY", () => {
  const contract = parseBoxtradesSpxContractPage(buildHtml(), "17DEC27");
  const adjusted = applySizeAdjustedApys(contract, 1.7, [200_000, 50_000]);

  assert.equal(adjusted.sizePremiumVsBenchmarkBps["200000"], 1.2);
  assert.equal(adjusted.sizePremiumVsBenchmarkBps["50000"], 2.2);
  assert.equal(adjusted.sizeAdjustedApyPercent["200000"], 4.1372);
  assert.equal(adjusted.sizeAdjustedApyPercent["50000"], 4.1469);
  assert.ok(
    (adjusted.fidelityAndSpreadAdjustedApyPercent["50000"] ?? 0) >
      adjusted.sizeAdjustedApyPercent["50000"]!,
  );
  assert.ok(
    (adjusted.fidelityAndSpreadAdjustedApyPercent["200000"] ?? 0) >
      adjusted.sizeAdjustedApyPercent["200000"]!,
  );
});

test("recentSizeAdjustedYieldPercent uses only the latest two trading days", () => {
  const day = 24 * 60 * 60 * 1000;
  const base = Date.UTC(2026, 3, 24);
  const yieldPercent = recentSizeAdjustedYieldPercent(
    {
      data: [
        { rate: 9, last: 980, volume: 1, ts: base },
        { rate: 8, last: 980, volume: 1, ts: base + 3 * day },
        { rate: 4.3, last: 980, volume: 1, ts: base + 4 * day },
        { rate: 4.4, last: 980, volume: 1, ts: base + 4 * day + 1 },
      ],
    },
    null,
  );

  assert.equal(yieldPercent, 5.5667);
});

test("recentSizeAdjustedYieldPercent weights the latest trades by received amount", () => {
  const base = Date.UTC(2026, 3, 28);
  const yieldPercent = recentSizeAdjustedYieldPercent(
    {
      data: [
        { rate: 4, last: 100, volume: 1, ts: base },
        { rate: 5, last: 100, volume: 2, ts: base + 1 },
        { rate: 8, last: 100, volume: 7, ts: base + 2 },
      ],
    },
    null,
  );

  assert.equal(yieldPercent, 7);
});

function buildSizeObservation({
  receivedAmount,
  ageDays,
}: {
  receivedAmount: number;
  ageDays: number;
}): SizeObservationFixture {
  const log10Notional = Math.log10(receivedAmount);
  return {
    log10Notional,
    receivedAmount,
    ageDays,
    residualYieldPercent: 0.12 - 0.02 * log10Notional,
  };
}

test("buildSizeModel uses 365-day eligible observations", () => {
  const observations = [
    ...Array.from({ length: 55 }, (_, index) =>
      buildSizeObservation({
        receivedAmount: 50_000 + index,
        ageDays: 10,
      }),
    ),
    ...Array.from({ length: 220 }, (_, index) =>
      buildSizeObservation({
        receivedAmount: index < 30 ? 1_000_000 + index : 250_000 + index,
        ageDays: 20,
      }),
    ),
  ];

  const model = buildSizeModel(observations);
  assert.equal(model.lookbackDays, 365);
  assert.equal(model.observations, 275);
  assert.equal(model.microObservations, 55);
  assert.equal(model.smallObservations, 55);
  assert.equal(model.largeObservations, 30);
});

test("buildSizeModel excludes observations older than 365 days", () => {
  const observations = [
    ...Array.from({ length: 240 }, (_, index) =>
      buildSizeObservation({
        receivedAmount: index < 20 ? 1_000_000 + index : 250_000 + index,
        ageDays: 10,
      }),
    ),
    ...Array.from({ length: 55 }, (_, index) =>
      buildSizeObservation({
        receivedAmount: 50_000 + index,
        ageDays: 75,
      }),
    ),
    buildSizeObservation({
      receivedAmount: 50_000,
      ageDays: 400,
    }),
  ];

  const model = buildSizeModel(observations);
  assert.equal(model.lookbackDays, 365);
  assert.equal(model.observations, 295);
  assert.equal(model.microObservations, 55);
  assert.equal(model.smallObservations, 55);
  assert.equal(model.largeObservations, 20);
});
