import test from "node:test";
import assert from "node:assert/strict";
import { warmUpStartDatesByIndex } from "@/lib/simulation/warm-up-by-index";
import { lineWarmUpDays, registerSignalRule, type SignalRule } from "@/lib/simulation/signal-rules";
import type { EtfConfig } from "@/lib/simulation/types";

type Cfg = Pick<EtfConfig, "smaIndex" | "smaEnabled" | "smaPeriod" | "signalRule">;
/** Fake warm-up: encodes the requested day count so assertions can read it back. */
const fake = (start: string, days: number) => `${start}-${String(days).padStart(3, "0")}`;

const rule = (id: string, warmUpDays: number): SignalRule => ({
  id, label: id, title: id, description: "Test rule.", warmUpDays, regime: (dates) => dates.map(() => true),
});

function withRules<T>(rules: SignalRule[], fn: () => T): T {
  const unregister = rules.map(registerSignalRule);
  try {
    return fn();
  } finally {
    unregister.forEach((undo) => undo());
  }
}

test("SMA configs share the run's longest SMA warm-up, as before", () => {
  const configs: Cfg[] = [
    { smaIndex: "sp500", smaEnabled: true, smaPeriod: 178 },
    { smaIndex: "nasdaq100", smaEnabled: true, smaPeriod: 136 },
  ];
  const { byIndex, earliest } = warmUpStartDatesByIndex(configs, "1988", fake);
  assert.deepEqual(byIndex, { sp500: "1988-178", nasdaq100: "1988-178" });
  assert.equal(earliest, "1988-178");
});

test("a rule line lengthens only its own index's warm-up", () => {
  withRules([rule("long", 252)], () => {
    const configs: Cfg[] = [
      { smaIndex: "sp500", smaEnabled: true, smaPeriod: 178 },
      { smaIndex: "nasdaq100", smaEnabled: true, smaPeriod: 136 },
      { smaIndex: "nasdaq100", smaEnabled: true, smaPeriod: 136, signalRule: "long" },
    ];
    assert.deepEqual(warmUpStartDatesByIndex(configs, "1988", fake).byIndex, { sp500: "1988-178", nasdaq100: "1988-252" });
  });
});

test("a rule line never shortens the shared warm-up, and needs at least its own band's period", () => {
  withRules([rule("long", 252), rule("short", 10)], () => {
    const configs: Cfg[] = [
      { smaIndex: "nasdaq100", smaEnabled: true, smaPeriod: 280 },
      { smaIndex: "nasdaq100", smaEnabled: true, smaPeriod: 136, signalRule: "long" },
    ];
    assert.deepEqual(warmUpStartDatesByIndex(configs, "1988", fake).byIndex, { nasdaq100: "1988-280" });
    assert.equal(lineWarmUpDays({ smaEnabled: true, smaPeriod: 136, signalRule: "short" }), 136);
    assert.equal(lineWarmUpDays({ smaEnabled: true, smaPeriod: 136, signalRule: "long" }), 252);
    assert.equal(lineWarmUpDays({ smaEnabled: false, smaPeriod: 136, signalRule: "long" }), 0);
  });
});

test("earliest is the longest per-index warm-up; SMA-off configs need none", () => {
  const real = (start: string, days: number) => {
    const d = new Date(`${start}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - days);
    return d.toISOString().slice(0, 10);
  };
  withRules([rule("short", 5)], () => {
    const configs: Cfg[] = [
      { smaIndex: "sp500", smaEnabled: false, smaPeriod: 0 },
      { smaIndex: "nasdaq100", smaEnabled: true, smaPeriod: 10, signalRule: "short" },
    ];
    const { byIndex, earliest } = warmUpStartDatesByIndex(configs, "2000-02-01", real);
    assert.deepEqual(byIndex, { sp500: "2000-02-01", nasdaq100: "2000-01-22" });
    assert.equal(earliest, "2000-01-22");
  });
  assert.equal(warmUpStartDatesByIndex([], "2000-02-01", real).earliest, "2000-02-01");
});
