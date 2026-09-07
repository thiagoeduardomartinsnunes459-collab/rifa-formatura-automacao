// Service worker só pra push notification do painel administrativo (admin.html).
// Não faz cache nem intercepta fetch -- a landing page e o painel continuam 100%
// online-only, isso aqui só recebe e mostra notificações mesmo com o navegador
// em segundo plano ou o celular bloqueado (Android).

self.addEventListener('push', (event) => {
  let dados = {};
  try {
    dados = event.data ? event.data.json() : {};
  } catch {
    dados = { title: 'Rifa Formatura', body: event.data ? event.data.text() : '' };
  }

  const titulo = dados.title || 'Rifa Formatura';
  const opcoes = {
    body: dados.body || '',
    tag: 'rifa-venda',
    data: { url: dados.url || '/admin.html' },
  };

  event.waitUntil(self.registration.showNotification(titulo, opcoes));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/admin.html';
  event.waitUntil(clients.openWindow(url));
});
