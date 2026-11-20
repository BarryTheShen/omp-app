/*
 * omp-app's service worker: the app's own notifications (Web Push) and nothing else. It caches nothing, so the page is
 * always the one the server serves. A push shows at once (Safari takes the permission away from a page whose pushes
 * show nothing); tapping it opens the app at the chat it names: an open window of the app is brought forward and told
 * to open the chat, else the app opens at `/#chat=<id>` (`workspace/linkChat.ts`). On an iPhone this is the only way a
 * notification opens the Home Screen app: a link from another app opens the browser.
 */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let message = {};
  try {
    message = event.data ? event.data.json() : {};
  } catch {
    message = { body: event.data ? event.data.text() : "" };
  }
  const title =
    typeof message.title === "string" && message.title !== "" ? message.title : "omp app";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof message.body === "string" ? message.body : "",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      ...(typeof message.tag === "string" ? { tag: message.tag } : {}),
      data: { chat: message.chat ?? null, path: message.path ?? null },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const { chat, path } = event.notification.data ?? {};
  const target = new URL(
    typeof chat === "string"
      ? `/#chat=${encodeURIComponent(chat)}`
      : typeof path === "string"
        ? path
        : "/",
    self.location.origin,
  ).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const open = windows.find((each) => new URL(each.url).origin === self.location.origin);
      if (open !== undefined) {
        await open.focus();
        if (typeof chat === "string") open.postMessage({ type: "omp-app:open-chat", chat });
        return;
      }
      await self.clients.openWindow(target);
    })(),
  );
});
