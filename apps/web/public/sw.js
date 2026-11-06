// Service worker STUB for web push. UNVERIFIED: push delivery needs VAPID keys, a subscription endpoint
// on the server, and a sender; none of those exist yet (see BLOCKERS.md). This only displays a payload if one arrives.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: "Recruiting OS", body: event.data ? event.data.text() : "" }; }
  event.waitUntil(self.registration.showNotification(data.title || "Recruiting OS", { body: data.body || "", data: { url: data.url || "/" }, icon: "/icon.svg" }));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow((event.notification.data && event.notification.data.url) || "/"));
});
