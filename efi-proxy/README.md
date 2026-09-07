# efi-proxy — Plano B

Proxy transparente pra contornar o bloqueio de IP do Make.com no WAF/Cloudflare
da Efí em **produção** (`pix.api.efipay.com.br`). Homologação nunca teve esse
problema; produção bloqueia especificamente o IP/range do Make.com — confirmado
testando a mesma aplicação/certificado de uma rede diferente (`HTTP 200`, token
válido). Ver histórico completo da investigação na conversa com o JARVIS.

**Status: implantado e testado em 07/09 — `POST /oauth/token` via o proxy
devolveu `200` com token válido e escopos corretos** (`https://efi-proxy-tau.vercel.app`).
Confirma que o proxy contorna o bloqueio. **Ainda não ativado no Make** — os
módulos do Scenario 1/2 continuam apontando direto pra `pix.api.efipay.com.br`
até vocês decidirem trocar (ver seção "Ativar no Make" abaixo).

Antes de trocar pra valer no Make, avise a Efí no chamado que vocês estão
rotando por uma infraestrutura própria — ver a conversa sobre risco de
antifraude/compliance antes de fazer isso silenciosamente.

## O que ele faz

O Make continua mandando exatamente a mesma chamada que manda hoje pra Efí
(mesmo método, path, headers, body) — só que pro proxy em vez de direto pra
`pix.api.efipay.com.br`. O proxy anexa o certificado mTLS de produção (que só
ele guarda) e repassa pra Efí de verdade, devolvendo a resposta sem alterar
nada.

```
Make.com ──HTTPS simples──► efi-proxy.vercel.app/api/efi/* ──HTTPS + mTLS──► pix.api.efipay.com.br
                             (cert vive só aqui)
```

## Deploy

Já implantado — projeto `efi-proxy` na conta Vercel do usuário, URL fixa
`https://efi-proxy-tau.vercel.app` (alias de produção, não muda a cada
redeploy). Pra redeployar depois de alguma alteração:

```bash
cd efi-proxy
vercel --prod
```

(a CLI já está instalada e logada nesta máquina; `vercel --prod` sozinho
reaproveita o projeto linkado em `.vercel/project.json`)

## Certificado (já configurado)

`EFI_PROD_CERT` e `EFI_PROD_KEY` já estão salvas como Environment Variables
(tipo "Sensitive") no projeto `efi-proxy` na Vercel — extraídas uma vez do
`certs/producao.p12` local e coladas direto no painel via `vercel env add`,
nunca ficaram em nenhum arquivo commitado. Se precisar recriar do zero num
outro projeto:

```
openssl pkcs12 -in certs/producao.p12 -clcerts -nokeys -passin pass: -out cert.pem
openssl pkcs12 -in certs/producao.p12 -nocerts -nodes -passin pass: -out key.pem
vercel env add EFI_PROD_CERT production < cert.pem
vercel env add EFI_PROD_KEY production < key.pem
rm cert.pem key.pem   # apaga logo depois, só existem pra colar
vercel --prod          # redeploy pra pegar as variáveis novas
```

## Teste já validado

```bash
curl -X POST https://efi-proxy-tau.vercel.app/api/efi/oauth/token \
  -u "$EFI_CLIENT_ID_PROD:$EFI_CLIENT_SECRET_PROD" \
  -H "Content-Type: application/json" \
  -d '{"grant_type": "client_credentials"}'
```

Rodado em 07/09: `200 OK`, `token_type: Bearer`, `scope: cob.read cob.write
webhook.write` — resposta genuína da Efí (header `Cf-Ray`, cookie de domínio
`efipay.com.br`), confirmando que o proxy contorna o bloqueio.

## Ativar no Make (só depois do teste acima funcionar)

Nos módulos HTTP que hoje apontam pra `https://pix.api.efipay.com.br`:

- **Scenario 1** ("Rifa - Reservar Numero + Gerar PIX"): módulos 4
  (`POST /v2/cob`), 5 (auth, se for chamada separada) e 6
  (`GET /v2/loc/:id/qrcode`)
- **Scenario 2** ("Rifa - Confirmar Pagamento Efi"): módulo 3
  (`GET /v2/cob/:txid`)

Em cada um:
1. Troca o host da URL de `pix.api.efipay.com.br` pra
   `efi-proxy-tau.vercel.app/api/efi` (mantém o resto do path igual, ex:
   `https://pix.api.efipay.com.br/v2/cob` vira
   `https://efi-proxy-tau.vercel.app/api/efi/v2/cob`).
2. **Remove a configuração de Client Certificate (mTLS) desses módulos** —
   não é mais necessária nesse hop, o proxy já cuida disso na ponta dele.
3. Mantém os headers de `Authorization` (Basic ou Bearer) como estão — o
   proxy só repassa.

O **webhook de confirmação da Efí pro Make** (Scenario 2, módulo 1) não muda —
é a Efí chamando o Make, direção que nunca teve bloqueio, então não passa por
este proxy.

## Rollback

Se algo der errado, é só voltar o host dos módulos pra
`pix.api.efipay.com.br` e recolocar a config de Client Certificate — nenhuma
mudança é destrutiva ou depende do proxy continuar no ar.
