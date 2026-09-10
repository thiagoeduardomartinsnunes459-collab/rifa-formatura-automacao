// Vercel Serverless Function (Node.js runtime) -- rede de seguranca contra o
// webhook de pagamento da Efi que nao esta entregando notificacoes de verdade
// (so responde ao ping de registro, nunca aos eventos de pagamento reais --
// investigado em 2026-09-07, aguardando retorno da Efi sobre a causa).
//
// Chamado por um Scheduler no Make a cada poucos minutos. Busca reservas
// "pendente" com cobranca ja criada, confere o status real na Efi, e confirma
// via confirmar_pagamento quando encontrar pagamento ja concluido -- sem
// depender do webhook. Dispara a notificacao push tambem, pra nao perder essa
// parte do fluxo quando o webhook falha.

import https from 'node:https';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const EFI_HOST = 'pix.api.efipay.com.br';

const agent = new https.Agent({
  cert: process.env.EFI_PROD_CERT,
  key: process.env.EFI_PROD_KEY,
});

function efiRequest(path, method, token) {
  return new Promise((resolve, reject) => {
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const req = https.request(
      { hostname: EFI_HOST, path, method, agent, headers },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, data: JSON.parse(body) });
          } catch {
            resolve({ status: res.statusCode, data: null });
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function getEfiToken() {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(
      `${process.env.EFI_CLIENT_ID_PROD}:${process.env.EFI_CLIENT_SECRET_PROD}`
    ).toString('base64');
    const body = JSON.stringify({ grant_type: 'client_credentials' });
    const req = https.request(
      {
        hostname: EFI_HOST,
        path: '/oauth/token',
        method: 'POST',
        agent,
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let out = '';
        res.on('data', (c) => (out += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(out).access_token);
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

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
  return res.json();
}

export default async function handler(req, res) {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !process.env.EFI_PROD_CERT) {
    res.status(500).json({ erro: 'Variaveis de ambiente nao configuradas.' });
    return;
  }

  const pendentes = await supabaseRest(
    '/reservas?status=eq.pendente&efi_txid=not.is.null&select=id,numero,efi_txid'
  );
  const pedidosPendentes = await supabaseRest(
    '/pedidos?status=eq.pendente&efi_txid=not.is.null&select=id,efi_txid'
  );

  const temReservas = Array.isArray(pendentes) && pendentes.length > 0;
  const temPedidos = Array.isArray(pedidosPendentes) && pedidosPendentes.length > 0;

  if (!temReservas && !temPedidos) {
    res.status(200).json({ verificadas: 0, confirmadas: 0 });
    return;
  }

  const token = await getEfiToken();
  let confirmadas = 0;
  const detalhes = [];

  for (const reserva of temReservas ? pendentes : []) {
    const cob = await efiRequest(`/v2/cob/${reserva.efi_txid}`, 'GET', token);

    if (cob.status !== 200 || cob.data?.status !== 'CONCLUIDA') {
      detalhes.push({ numero: reserva.numero, status: cob.data?.status || 'erro' });
      continue;
    }

    const pixInfo = cob.data.pix?.[0];
    const gatewayTxid = pixInfo?.endToEndId || `auto-${reserva.efi_txid}`;

    const confirmacao = await supabaseRest('/rpc/confirmar_pagamento', {
      method: 'POST',
      body: JSON.stringify({
        p_gateway_txid: gatewayTxid,
        p_reserva_id: reserva.id,
        p_payload: cob.data,
      }),
    });

    const sucesso = Array.isArray(confirmacao) && confirmacao[0]?.sucesso;
    detalhes.push({ numero: reserva.numero, status: 'CONCLUIDA', confirmado: !!sucesso });

    if (sucesso) {
      confirmadas += 1;
      try {
        await fetch(`https://${req.headers.host}/api/push/notify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ numero: reserva.numero }),
        });
      } catch {
        // notificacao push nao é crítica -- nao bloqueia a reconciliacao
      }
    }
  }

  // Mesma logica acima, mas pra pedidos (varios numeros sob uma unica cobranca) --
  // ver reservar_pedido/confirmar_pagamento_pedido em supabase/schema.sql.
  for (const pedido of temPedidos ? pedidosPendentes : []) {
    const cob = await efiRequest(`/v2/cob/${pedido.efi_txid}`, 'GET', token);

    if (cob.status !== 200 || cob.data?.status !== 'CONCLUIDA') {
      detalhes.push({ pedido_id: pedido.id, status: cob.data?.status || 'erro' });
      continue;
    }

    const pixInfo = cob.data.pix?.[0];
    const gatewayTxid = pixInfo?.endToEndId || `auto-${pedido.efi_txid}`;

    const confirmacao = await supabaseRest('/rpc/confirmar_pagamento_pedido', {
      method: 'POST',
      body: JSON.stringify({
        p_gateway_txid: gatewayTxid,
        p_pedido_id: pedido.id,
        p_payload: cob.data,
      }),
    });

    const resultado = Array.isArray(confirmacao) ? confirmacao[0] : null;
    const sucesso = resultado?.sucesso;
    const numerosConfirmados = resultado?.numeros || [];
    detalhes.push({ pedido_id: pedido.id, status: 'CONCLUIDA', confirmado: !!sucesso, numeros: numerosConfirmados });

    if (sucesso) {
      confirmadas += 1;
      try {
        await fetch(`https://${req.headers.host}/api/push/notify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ numeros: numerosConfirmados }),
        });
      } catch {
        // notificacao push nao é crítica -- nao bloqueia a reconciliacao
      }
    }
  }

  res.status(200).json({
    verificadas: (temReservas ? pendentes.length : 0) + (temPedidos ? pedidosPendentes.length : 0),
    confirmadas,
    detalhes,
  });
}
