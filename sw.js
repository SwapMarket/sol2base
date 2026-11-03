// Service worker: only needed so the page can show notifications on Android Chrome
// (it doesn't support `new Notification()`), and to bring the page back when one is tapped.

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const page = windows.find((c) => c.url.startsWith(self.registration.scope));
    if (page) return page.focus();
    return self.clients.openWindow(self.registration.scope);
  })());
});
