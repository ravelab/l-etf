import test from "node:test";
import assert from "node:assert/strict";
import { detectInstallPlatform, isAndroidDevice, isIosDevice } from "../src/lib/push/client";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const IPAD = "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";
// Chrome on iOS advertises CriOS AND iPhone; it must still take the iOS path,
// because only Safari's Share sheet can add to the Home Screen there.
const CHROME_ON_IOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.0.0 Mobile/15E148 Safari/604.1";
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function withUserAgent(ua: string, run: () => void) {
  const original = globalThis.navigator;
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: ua },
    configurable: true,
    writable: true,
  });
  try {
    run();
  } finally {
    Object.defineProperty(globalThis, "navigator", {
      value: original,
      configurable: true,
      writable: true,
    });
  }
}

test("install platform is detected from the user agent", () => {
  withUserAgent(IPHONE, () => {
    assert.equal(isIosDevice(), true);
    assert.equal(detectInstallPlatform(), "ios");
  });
  withUserAgent(IPAD, () => assert.equal(detectInstallPlatform(), "ios"));
  withUserAgent(ANDROID, () => {
    assert.equal(isAndroidDevice(), true);
    assert.equal(detectInstallPlatform(), "android");
  });
  withUserAgent(MAC, () => {
    assert.equal(isIosDevice(), false);
    assert.equal(isAndroidDevice(), false);
    assert.equal(detectInstallPlatform(), "desktop");
  });
});

test("Chrome on iOS takes the iOS path, not Android", () => {
  withUserAgent(CHROME_ON_IOS, () => {
    assert.equal(detectInstallPlatform(), "ios");
  });
});

test("platform detection is safe when navigator is absent (SSR)", () => {
  const original = globalThis.navigator;
  Object.defineProperty(globalThis, "navigator", { value: undefined, configurable: true, writable: true });
  try {
    assert.equal(isIosDevice(), false);
    assert.equal(isAndroidDevice(), false);
    assert.equal(detectInstallPlatform(), "desktop");
  } finally {
    Object.defineProperty(globalThis, "navigator", { value: original, configurable: true, writable: true });
  }
});
