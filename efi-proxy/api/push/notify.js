// Vercel Serverless Function (Node.js runtime) -- dispara push notification pra
// cliente (painel administrativo) toda vez que uma venda é confirmada.
//
// Chamado pelo Make (Scenario 2 "Rifa - Confirmar Pagamento Efi (PRODUCAO)"),
// como último módulo, só depois que confirmar_pagamento retorna sucesso=true.
// Body esperado: { "numero": 42 }
//
// Usa a service_role key do Supabase (bypassa RLS) pra ler o nome do comprador
// e a lista de inscrições push -- nunca a chave anon. Equivalente ao papel que o
// Make já tem em relação ao Supabase neste projeto.

import webpush from 'web-push';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

async function supabaseRest(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  return res;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ erro: 'Method not allowed' });
    return;
  }

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !process.env.VAPID_PRIVATE_KEY) {
    res.status(500).json({ erro: 'Variaveis de ambiente nao configuradas (SUPABASE/VAPID).' });
    return;
  }

  const { numero, numeros } = req.body || {};
  const listaNumeros = Array.isArray(numeros) && numeros.length > 0 ? numeros : numero ? [numero] : [];
  if (listaNumeros.length === 0) {
    res.status(400).json({ erro: 'Campo "numero" ou "numeros" obrigatorio no body.' });
    return;
  }

  // Nome do comprador (venda mais recente confirmada pra algum desses numeros --
  // num pedido, todos os numeros pertencem ao mesmo comprador).
  let nome = 'alguém';
  try {
    const filtroNumeros = listaNumeros.length === 1 ? `eq.${listaNumeros[0]}` : `in.(${listaNumeros.join(',')})`;
    const compradorRes = await supabaseRest(
      `/reservas?numero=${filtroNumeros}&status=eq.paga&select=nome&order=paga_em.desc&limit=1`
    );
    const compradorData = await compradorRes.json();
    if (Array.isArray(compradorData) && compradorData[0]?.nome) {
      nome = compradorData[0].nome;
    }
  } catch {
    // segue com "alguém" -- não bloqueia a notificação por causa disso
  }

  const subsRes = await supabaseRest('/push_subscriptions?select=endpoint,p256dh,auth');
  const subscriptions = await subsRes.json();

  if (!Array.isArray(subscriptions) || subscriptions.length === 0) {
    res.status(200).json({ enviados: 0, motivo: 'nenhuma inscricao ativa' });
    return;
  }

  const numerosFormatados = listaNumeros.map((n) => String(n).padStart(4, '0'));
  const plural = numerosFormatados.length > 1;
  const listaTexto =
    numerosFormatados.length <= 2
      ? numerosFormatados.join(' e ')
      : `${numerosFormatados.slice(0, -1).join(', ')} e ${numerosFormatados[numerosFormatados.length - 1]}`;
  const payload = JSON.stringify({
    title: plural ? '🎟️ Números vendidos!' : '🎟️ Número vendido!',
    body: `Número${plural ? 's' : ''} ${listaTexto} vendido${plural ? 's' : ''} pra ${nome}.`,
    url: '/admin.html',
  });

  let enviados = 0;
  const expiradas = [];

  await Promise.all(
    subscriptions.map(async (sub) => {
      const subscription = {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth },
      };
      try {
        await webpush.sendNotification(subscription, payload);
        enviados += 1;
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          expiradas.push(sub.endpoint);
        }
      }
    })
  );

  if (expiradas.length > 0) {
    await Promise.all(
      expiradas.map((endpoint) =>
        supabaseRest(`/push_subscriptions?endpoint=eq.${encodeURIComponent(endpoint)}`, {
          method: 'DELETE',
        })
      )
    );
  }

  res.status(200).json({ enviados, removidas: expiradas.length });
}

export const config = {
  api: {
    bodyParser: true,
  },
};
