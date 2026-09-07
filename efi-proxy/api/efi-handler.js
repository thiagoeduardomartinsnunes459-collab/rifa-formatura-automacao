// Vercel Serverless Function (Node.js runtime) — proxy transparente pra API
// de producao da Efi, carregando o certificado mTLS aqui em vez de no Make.
//
// Por que existe: o WAF/Cloudflare da Efi em producao bloqueia chamadas vindas
// do IP do Make.com (ver README.md nesta pasta). Este proxy reencaminha a
// chamada a partir de uma origem de rede diferente, anexando o mesmo
// certificado que ja funciona em homologacao.
//
// Roteamento: vercel.json reescreve /api/efi/<qualquer-coisa> pra
// /api/efi-handler?path=<qualquer-coisa>, entao "path" abaixo e o path real
// da Efi (ex: "oauth/token", "v2/cob").

import https from 'node:https';

const EFI_HOST = 'pix.api.efipay.com.br';

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  const cert = process.env.EFI_PROD_CERT;
  const key = process.env.EFI_PROD_KEY;

  if (!cert || !key) {
    res.status(500).json({
      erro: 'EFI_PROD_CERT / EFI_PROD_KEY nao configurados nas Environment Variables do projeto.',
    });
    return;
  }

  const pathParam = req.query.path;
  const efiPath = '/' + (Array.isArray(pathParam) ? pathParam.join('/') : pathParam || '');

  const hasBody = !['GET', 'HEAD'].includes(req.method);
  const body = hasBody ? await readRawBody(req) : undefined;

  const agent = new https.Agent({ cert, key });

  const forwardedHeaders = { ...req.headers };
  delete forwardedHeaders.host;
  delete forwardedHeaders['content-length'];

  const upstreamReq = https.request(
    {
      hostname: EFI_HOST,
      path: efiPath,
      method: req.method,
      agent,
      headers: {
        ...forwardedHeaders,
        host: EFI_HOST,
      },
    },
    (upstreamRes) => {
      res.status(upstreamRes.statusCode || 502);
      for (const [k, v] of Object.entries(upstreamRes.headers)) {
        if (v !== undefined) res.setHeader(k, v);
      }
      upstreamRes.pipe(res);
    }
  );

  upstreamReq.on('error', (err) => {
    res.status(502).json({ erro: 'Falha ao repassar chamada pra Efi', detalhe: err.message });
  });

  if (body && body.length > 0) upstreamReq.write(body);
  upstreamReq.end();
}

// Precisamos do body cru (sem o Vercel re-serializar) pra repassar exatamente
// o que o Make mandou, byte a byte.
export const config = {
  api: {
    bodyParser: false,
  },
};
