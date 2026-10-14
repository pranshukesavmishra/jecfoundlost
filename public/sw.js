/* Service worker: shows push notifications and opens the right page when tapped. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data && event.data.text() }; }
  const title = data.title || 'JEC Lost & Found';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    icon: '/img/icon-192.png',
    badge: '/img/badge-72.png',
    image: data.image,
    data: { url: data.url || '/' },
    tag: data.url,
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (c.url === url && 'focus' in c) return c.focus();
    }
    return self.clients.openWindow(url);
  })());
});
