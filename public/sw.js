self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  const envelope = readPushPayload(event);
  const payload = readNotificationPayload(envelope);
  const title = payload.title || envelope.title || "L-ETF SMA alert";
  const options = {
    body: payload.body || envelope.body || "SMA status changed.",
    tag: payload.tag || envelope.tag || "l-etf-sma-status",
    renotify: true,
    data: {
      url: payload.data?.url || payload.navigate || envelope.url || "/signals",
    },
    icon: "/icon.png",
    badge: "/icon.png",
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

function readNotificationPayload(envelope) {
  if (envelope?.notification && typeof envelope.notification === "object") {
    return envelope.notification;
  }
  return envelope || {};
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification?.data?.url || "/signals";
  event.waitUntil(focusOrOpenWindow(url));
});

function readPushPayload(event) {
  if (!event.data) return {};
  try {
    return event.data.json();
  } catch {
    return {
      body: event.data.text(),
    };
  }
}

async function focusOrOpenWindow(pathname) {
  const url = getSameOriginUrl(pathname);
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of clients) {
    if ("focus" in client) {
      if (client.url === url || client.url.startsWith(url)) {
        return client.focus();
      }
    }
  }
  return self.clients.openWindow(url);
}

function getSameOriginUrl(pathname) {
  try {
    const url = new URL(pathname || "/signals", self.location.origin);
    if (url.origin !== self.location.origin) return new URL("/signals", self.location.origin).href;
    return url.href;
  } catch {
    return new URL("/signals", self.location.origin).href;
  }
}
