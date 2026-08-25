/**
 * Push endpoints arrive from unauthenticated callers and are later POSTed to
 * from trusted contexts — including the deploy container that holds the VAPID
 * private key, CRON_SECRET, and the data-provider keys. An unrestricted
 * endpoint therefore turns subscribe into a blind SSRF primitive that also
 * hands an attacker host a signed VAPID JWT, so endpoints are pinned to HTTPS
 * on the push services browsers actually use.
 *
 * Extend these lists when adding support for a browser whose push service is
 * not represented; never relax them to accept arbitrary hosts.
 */
const ALLOWED_ENDPOINT_HOSTS: readonly string[] = [
  "fcm.googleapis.com",
  "android.googleapis.com",
  "updates.push.services.mozilla.com",
  "web.push.apple.com",
];

const ALLOWED_ENDPOINT_HOST_SUFFIXES: readonly string[] = [
  ".push.services.mozilla.com",
  ".push.apple.com",
  ".notify.windows.com",
  ".push.microsoft.com",
];

export function isAllowedPushEndpoint(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if (url.protocol !== "https:") return false;
  // Credentials in the authority are a classic way to make a URL read as a
  // trusted host while resolving somewhere else.
  if (url.username !== "" || url.password !== "") return false;

  const host = url.hostname.toLowerCase();
  if (ALLOWED_ENDPOINT_HOSTS.includes(host)) return true;
  return ALLOWED_ENDPOINT_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

export const PUSH_ENDPOINT_ERROR = "Unsupported push endpoint";
