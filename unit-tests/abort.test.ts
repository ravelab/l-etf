import test from "node:test";
import assert from "node:assert/strict";
import { abortError, isAbortError, throwIfAborted } from "../src/lib/abort";

test("cancellation raised by throwIfAborted is recognised by isAbortError", () => {
  const controller = new AbortController();
  controller.abort();

  assert.throws(
    () => throwIfAborted(controller.signal),
    (err: unknown) => isAbortError(err),
    "a cancelled run must surface as an AbortError, not a generic failure"
  );
});

test("a plain Error('Aborted') is NOT treated as cancellation", () => {
  // Guards against reintroducing the bug: pages used to throw this, so Cancel
  // fell through to the error branch and wiped the displayed results.
  assert.equal(isAbortError(new Error("Aborted")), false);
});

test("throwIfAborted is a no-op while the signal is live", () => {
  const controller = new AbortController();
  assert.doesNotThrow(() => throwIfAborted(controller.signal));
  assert.doesNotThrow(() => throwIfAborted(undefined));
});

test("abortError prefers an Error reason supplied by the caller", () => {
  const controller = new AbortController();
  const reason = new Error("user pressed cancel");
  controller.abort(reason);
  assert.equal(abortError(controller.signal), reason);
  assert.equal(isAbortError(abortError()), true);
});
