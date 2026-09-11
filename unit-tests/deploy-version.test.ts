import test from "node:test";
import assert from "node:assert/strict";
import {
  DEPLOY_ID_STORAGE_KEY,
  DEPLOY_RESUME_HIDDEN_MS,
  DEPLOY_UPDATE_NOTICE_MS,
  DEPLOY_UPDATE_NOTICE_RESUME_MS,
  decideDeployAction,
  deployUpdateNoticeMs,
  isDeployStorageUpdate,
  parseDeployVersion,
} from "@/lib/deploy-version";

test("parseDeployVersion: accepts the documented { v: string } body", () => {
  assert.equal(parseDeployVersion({ v: "dpl_abc123" }), "dpl_abc123");
  assert.equal(parseDeployVersion({ v: "  dpl_abc123  " }), "dpl_abc123");
});

test("parseDeployVersion: rejects anything that would reload the tab on every poll", () => {
  for (const body of [null, undefined, "dpl_abc123", 42, [], {}, { v: "" }, { v: "   " }, { v: 7 }, { v: null }]) {
    assert.equal(parseDeployVersion(body), null, `expected null for ${JSON.stringify(body) ?? "undefined"}`);
  }
});

test("decideDeployAction: first id seen is adopted silently, never shown as an update", () => {
  assert.equal(decideDeployAction(null, "dpl_abc123"), "adopt");
});

test("decideDeployAction: same id is a no-op", () => {
  assert.equal(decideDeployAction("dpl_abc123", "dpl_abc123"), "ignore");
});

test("decideDeployAction: a different id triggers the update popup", () => {
  assert.equal(decideDeployAction("dpl_abc123", "dpl_def456"), "update");
});

test("decideDeployAction: an unusable response never updates", () => {
  assert.equal(decideDeployAction("dpl_abc123", null), "ignore");
  assert.equal(decideDeployAction(null, null), "ignore");
});

const storageEvent = (key: string | null, oldValue: string | null, newValue: string | null) =>
  ({ key, oldValue, newValue }) as Pick<StorageEvent, "key" | "oldValue" | "newValue">;

test("isDeployStorageUpdate: another tab adopting a newer id pulls this tab along", () => {
  assert.equal(
    isDeployStorageUpdate(storageEvent(DEPLOY_ID_STORAGE_KEY, "dpl_abc123", "dpl_def456")),
    true
  );
  assert.equal(isDeployStorageUpdate(storageEvent(DEPLOY_ID_STORAGE_KEY, null, "dpl_def456")), true);
});

test("isDeployStorageUpdate: ignores other keys, clears, and no-op writes", () => {
  assert.equal(isDeployStorageUpdate(storageEvent("theme", "light", "dark")), false);
  assert.equal(isDeployStorageUpdate(storageEvent(null, null, "dpl_def456")), false);
  assert.equal(isDeployStorageUpdate(storageEvent(DEPLOY_ID_STORAGE_KEY, "dpl_abc123", null)), false);
  assert.equal(isDeployStorageUpdate(storageEvent(DEPLOY_ID_STORAGE_KEY, "dpl_abc123", "   ")), false);
  assert.equal(
    isDeployStorageUpdate(storageEvent(DEPLOY_ID_STORAGE_KEY, "dpl_abc123", "dpl_abc123")),
    false
  );
});

test("deployUpdateNoticeMs: a tab the user is looking at still gets the notice", () => {
  assert.equal(deployUpdateNoticeMs(null), DEPLOY_UPDATE_NOTICE_MS);
  assert.equal(deployUpdateNoticeMs(0), DEPLOY_UPDATE_NOTICE_MS);
  assert.equal(deployUpdateNoticeMs(DEPLOY_RESUME_HIDDEN_MS - 1), DEPLOY_UPDATE_NOTICE_MS);
});

test("deployUpdateNoticeMs: a long stretch hidden is a relaunch, so no notice", () => {
  assert.ok(DEPLOY_UPDATE_NOTICE_RESUME_MS < DEPLOY_UPDATE_NOTICE_MS);
  assert.equal(deployUpdateNoticeMs(DEPLOY_RESUME_HIDDEN_MS), DEPLOY_UPDATE_NOTICE_RESUME_MS);
  assert.equal(deployUpdateNoticeMs(60 * 60 * 1000), DEPLOY_UPDATE_NOTICE_RESUME_MS);
});

test("deployUpdateNoticeMs: a backwards clock is not read as a resume", () => {
  assert.equal(deployUpdateNoticeMs(-5000), DEPLOY_UPDATE_NOTICE_MS);
});
