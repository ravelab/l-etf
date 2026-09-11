// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { DeployVersionWatcher } from "@/components/DeployVersionWatcher";
import {
  DEPLOY_FIRST_CHECK_MS,
  DEPLOY_ID_STORAGE_KEY,
  DEPLOY_RESUME_HIDDEN_MS,
  DEPLOY_UPDATE_NOTICE_MS,
} from "@/lib/deploy-version";

const RUNNING = "dpl_running";
const SHIPPED = "dpl_shipped";

/** jsdom has no PageTransitionEvent in every version; only `persisted` is read. */
const pageShowEvent = (persisted: boolean): Event => {
  const event = new Event("pageshow");
  Object.defineProperty(event, "persisted", { value: persisted });
  return event;
};

describe("DeployVersionWatcher", () => {
  let reload: ReturnType<typeof vi.fn>;
  let fetchMock: ReturnType<typeof vi.fn>;
  /** Deployment id the stubbed /api/deploy-version currently answers with. */
  let served: string;
  let visibility: DocumentVisibilityState;

  /** Runs timers and flushes the fetch microtasks they release. */
  const advance = async (ms: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  };

  /** Fires every [target, event] pair in one task, the way a real resume does. */
  const dispatch = async (...pairs: [EventTarget, Event][]) => {
    await act(async () => {
      for (const [target, event] of pairs) target.dispatchEvent(event);
      await Promise.resolve();
    });
  };

  const setVisibility = async (next: DocumentVisibilityState) => {
    visibility = next;
    await dispatch([document, new Event("visibilitychange")]);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    served = RUNNING;
    visibility = "visible";
    reload = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, reload },
    });
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility,
    });
    fetchMock = vi.fn(
      async () => ({ ok: true, json: async () => ({ v: served }) }) as unknown as Response
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("adopts the first id it sees without reloading", async () => {
    render(<DeployVersionWatcher />);
    await advance(DEPLOY_FIRST_CHECK_MS);
    expect(localStorage.getItem(DEPLOY_ID_STORAGE_KEY)).toBe(RUNNING);
    expect(reload).not.toHaveBeenCalled();
  });

  it("keeps the full notice when the update lands mid-session", async () => {
    localStorage.setItem(DEPLOY_ID_STORAGE_KEY, RUNNING);
    served = SHIPPED;
    render(<DeployVersionWatcher />);

    await advance(DEPLOY_FIRST_CHECK_MS);
    expect(reload).not.toHaveBeenCalled();
    await advance(DEPLOY_UPDATE_NOTICE_MS - 1);
    expect(reload).not.toHaveBeenCalled();
    await advance(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("cuts the notice when the update is found returning from a long stretch hidden", async () => {
    localStorage.setItem(DEPLOY_ID_STORAGE_KEY, RUNNING);
    render(<DeployVersionWatcher />);
    await advance(DEPLOY_FIRST_CHECK_MS);

    served = SHIPPED;
    await setVisibility("hidden");
    await advance(DEPLOY_RESUME_HIDDEN_MS);
    await setVisibility("visible");

    await advance(0);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("keeps the notice for a return from a brief tab switch", async () => {
    localStorage.setItem(DEPLOY_ID_STORAGE_KEY, RUNNING);
    render(<DeployVersionWatcher />);
    await advance(DEPLOY_FIRST_CHECK_MS);

    served = SHIPPED;
    await setVisibility("hidden");
    await advance(DEPLOY_RESUME_HIDDEN_MS - 1);
    await setVisibility("visible");

    await advance(0);
    expect(reload).not.toHaveBeenCalled();
    await advance(DEPLOY_UPDATE_NOTICE_MS);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("treats a persisted pageshow as a relaunch even with no hidden span recorded", async () => {
    localStorage.setItem(DEPLOY_ID_STORAGE_KEY, RUNNING);
    render(<DeployVersionWatcher />);
    await advance(DEPLOY_FIRST_CHECK_MS);

    served = SHIPPED;
    await dispatch([window, pageShowEvent(true)]);

    await advance(0);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("ignores the initial non-persisted pageshow", async () => {
    render(<DeployVersionWatcher />);
    await dispatch([window, pageShowEvent(false)]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches once when one resume fires visibility, focus and pageshow together", async () => {
    localStorage.setItem(DEPLOY_ID_STORAGE_KEY, RUNNING);
    render(<DeployVersionWatcher />);
    await advance(DEPLOY_FIRST_CHECK_MS);

    await setVisibility("hidden");
    await advance(DEPLOY_RESUME_HIDDEN_MS);
    fetchMock.mockClear();

    visibility = "visible";
    await dispatch(
      [document, new Event("visibilitychange")],
      [window, new Event("focus")],
      [window, pageShowEvent(true)]
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
