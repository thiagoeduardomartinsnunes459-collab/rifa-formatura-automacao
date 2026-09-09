# Configuração dos Scenarios no Make.com

Make não tem uma API de scripting confiável pra montar scenarios do zero — os módulos
precisam ser conectados manualmente na interface. Este guia é o roteiro exato pra montar
os dois scenarios que fecham o fluxo da Versão A (grade de números + Postgres/Supabase),
usando **Efí (ex-Gerencianet)** como gateway.

**Por que Efí e não PicPay/Mercado Pago:** o cliente queria evitar uma carteira
intermediária que retém o valor até um saque manual. A cobrança PIX da Efí exige uma
chave PIX cadastrada **na própria conta Efí** (uma chave só pode estar vinculada a um
banco/PSP por vez, então não dá pra usar diretamente a chave que já está no Nubank sem
portá-la). A cliente resolveu isso cadastrando uma **chave aleatória nova, direto no app
do Efí** — caminho mais simples que portabilidade. O valor cai na conta digital do Efí
(visível no app dela), e ela transfere por PIX pro Nubank quando quiser; ainda é conta
própria, sem intermediário de terceiros reter o saldo. Isso também resolve de vez a
dúvida de compatibilidade de QR que tínhamos com o PicPay: cobrança Efí gera um PIX BR
Code padrão, aceito por qualquer banco.

> ✅ **Fluxo completo testado em homologação, ponta a ponta (03/09).** Os dois scenarios
> abaixo estão montados, ativos, e validados com uma cobrança PIX real de sandbox (reserva
> → autenticação mTLS → criação da cobrança → webhook de confirmação → `numeros.status =
> 'pago'`). Detalhes que mudaram em relação ao plano original:
>
> - **Certificado mTLS no módulo HTTP do Make funciona**, mas o certificado/chave devem
>   ser colados diretamente nos campos "Certificate"/"Private key" da keychain — a opção
>   "Extract" a partir do `.p12` falhou (`Invalid password?`) mesmo com senha vazia
>   correta. Extraia localmente com `openssl` e cole o PEM puro (nunca copie via
>   WhatsApp/Bloco de Notas — caracteres invisíveis corrompem o certificado e geram
>   `error:1E08010C:DECODER routines::unsupported` no Make, mesmo com o arquivo correto).
> - **QR Code não vem pronto da Efí.** O endpoint `GET /v2/loc/:id/qrcode` retorna 403
>   (`insufficient_scope`) porque a aplicação Efí da cliente não tem esse escopo liberado.
>   Contornado gerando o QR Code **no navegador**, a partir do `pixCopiaECola` que já vem
>   na resposta de `POST /v2/cob` (ver `landing/app.js`, lib `qrcode` via CDN).
> - **Webhook da Efí exige mTLS por padrão no receptor** — como o Make não expõe um
>   servidor com certificado próprio, o registro do webhook (`PUT /v2/webhook/:chave`)
>   precisa do header `x-skip-mtls-checking: true`, senão a Efí recusa com
>   `webhook_invalido`.
> - O ambiente de homologação da Efí **simula pagamento automaticamente** depois de um
>   tempo em cobranças de teste — não é preciso pagar de verdade pra testar o Scenario 2.

Pré-requisito: rode `supabase/schema.sql` no projeto Supabase antes de configurar
qualquer scenario aqui — os módulos abaixo dependem das funções `reservar_numero`,
`vincular_txid_efi`, `reserva_id_por_txid` e `confirmar_pagamento` já existirem.

## Status atual (já construído no Make)

### Scenario 1 — "Rifa - Reservar Numero + Gerar PIX" (ID 6130107, ativo)

- ✅ Webhook trigger → `reservar_numero` (Supabase) → Router
- ✅ Rota "falhou": responde `{sucesso:false, motivo:"numero_indisponivel"}`
- ✅ Rota "ok": autentica na Efí (mTLS + Basic Auth) → `POST /v2/cob` → `vincular_txid_efi`
  → responde `{sucesso:true, reserva_id, copia_cola}` (QR Code é gerado no front-end)

### Scenario 2 — "Rifa - Confirmar Pagamento Efi" (ID 6142000, ativo)

- ✅ Webhook trigger (URL já registrada na Efí com `x-skip-mtls-checking: true`) → Iterator
  sobre `pix[]` → autentica na Efí → `GET /v2/cob/:txid` (nunca confia só no payload do
  webhook) → filtro `status = CONCLUIDA` → `reserva_id_por_txid` → `confirmar_pagamento`
  (idempotente por `gateway_txid`, testado com reenvio duplicado — não duplica)

**Pendente:** repetir a configuração de certificado/keychain para **produção** quando a
cliente estiver pronta pra cobrar de verdade (hoje tudo aponta pra
`pix-h.api.efipay.com.br`, sandbox). Passo opcional do checklist original (notificação
WhatsApp automática) ainda não construído — o fallback manual (chave PIX + link do
WhatsApp na landing page) cobre isso por enquanto.

---

## Scenario 1 — Reservar Número + Gerar Cobrança PIX (Efí)

**Dispara quando:** o comprador envia o formulário na landing page.

| # | Módulo | Configuração |
|---|--------|--------------|
| 1 | **Webhooks → Custom webhook** | Cria o webhook, copia a URL gerada pra `config.js` → `MAKE_WEBHOOK_RESERVAR`. Body esperado: `{ numero, nome, whatsapp, cpf }` |
| 2 | **HTTP → Make a request** | `POST {SUPABASE_URL}/rest/v1/rpc/reservar_numero`<br>Headers: `apikey: {SERVICE_ROLE_KEY}`, `Authorization: Bearer {SERVICE_ROLE_KEY}`, `Content-Type: application/json`<br>Body: `{"p_numero": {{1.numero}}, "p_nome": "{{1.nome}}", "p_whatsapp": "{{1.whatsapp}}", "p_cpf": "{{1.cpf}}", "p_minutos": 15}` |
| 3 | **Router** | Ramo A: `{{2.sucesso}} = false` → vai direto pro passo 8 (resposta de erro). Ramo B: `{{2.sucesso}} = true` → segue pro passo 4. |
| 4 | **HTTP → Make a request** (Ramo B, com conexão de Client Certificate configurada) | `POST https://pix.api.efipay.com.br/v2/cob`<br>Headers: `Authorization: Bearer {EFI_ACCESS_TOKEN}`, `Content-Type: application/json`<br>Body:<br>`{"calendario": {"expiracao": 900}, "devedor": {"cpf": "{{1.cpf}}", "nome": "{{1.nome}}"}, "valor": {"original": "10.00"}, "chave": "{EFI_CHAVE_PIX}", "solicitacaoPagador": "Rifa Formatura - Número {{1.numero}}"}` |
| 5 | **HTTP → Make a request** (Ramo B) | `POST {SUPABASE_URL}/rest/v1/rpc/vincular_txid_efi`<br>Headers: `apikey: {SERVICE_ROLE_KEY}`, `Authorization: Bearer {SERVICE_ROLE_KEY}`<br>Body: `{"p_reserva_id": "{{2.reserva_id}}", "p_txid": "{{4.txid}}"}`<br>Grava o txid pra o Scenario 2 conseguir achar essa reserva depois. |
| 6 | **HTTP → Make a request** (Ramo B) | `GET https://pix.api.efipay.com.br/v2/loc/{{4.loc.id}}/qrcode`<br>Header: `Authorization: Bearer {EFI_ACCESS_TOKEN}`<br>Retorna `qrcode` (copia-e-cola) e `imagemQrcode` (base64) |
| 7 | **Webhooks → Webhook response** (Ramo B) | Status 200. Body: `{"sucesso": true, "reserva_id": "{{2.reserva_id}}", "qrcode_base64": "{{6.imagemQrcode}}", "copia_cola": "{{6.qrcode}}"}` |
| 8 | **Webhooks → Webhook response** (Ramo A) | Status 200. Body: `{"sucesso": false, "motivo": "{{2.motivo}}"}` |

**`EFI_ACCESS_TOKEN` do passo 4/5 vem de um módulo de autenticação separado** (não listado
como passo numerado porque normalmente vira uma "conexão" reutilizável no Make): `POST
https://pix.api.efipay.com.br/oauth/token` com Basic Auth (`client_id`:`client_secret`) +
o certificado mTLS anexado, body `{"grant_type": "client_credentials"}`. Configure isso
como a conexão HTTP do Make antes dos módulos 4/5, pra não repetir o auth em cada cobrança.

**Por que usar `txid` implícito (POST /v2/cob) em vez de `txid` próprio (PUT /v2/cob/:txid):**
mais simples de montar no Make — a Efí gera o `txid` e ele vem na resposta do passo 4
(`{{4.txid}}`), guarde-o pra usar no Scenario 2.

**Ambiente de homologação:** antes de testar com dinheiro real, use
`https://pix-h.api.efipay.com.br` (mesmo formato, chaves de sandbox) pra validar o fluxo
inteiro sem cobrar ninguém de verdade.

---

## Scenario 2 — Confirmar Pagamento (webhook da Efí)

**Dispara quando:** a Efí notifica que um PIX foi recebido na chave configurada.

Configuração prévia: registre a URL deste scenario como webhook da chave PIX, uma vez só,
via `PUT https://pix.api.efipay.com.br/v2/webhook/{EFI_CHAVE_PIX}` com body
`{"webhookUrl": "{URL_DESTE_SCENARIO}"}` (pode rodar isso direto no painel da Efí também,
sem precisar de scenario extra pra isso).

| # | Módulo | Configuração |
|---|--------|--------------|
| 1 | **Webhooks → Custom webhook** | Recebe `{ pix: [{ endToEndId, txid, valor, horario, ... }] }` da Efí. Pode vir mais de um pagamento por notificação — iterar a lista. |
| 2 | **Iterator** | Itera sobre `{{1.pix}}`. |
| 3 | **HTTP → Make a request** | `GET https://pix.api.efipay.com.br/v2/cob/{{2.txid}}`<br>Header: `Authorization: Bearer {EFI_ACCESS_TOKEN}`<br>**Nunca confie só no payload do webhook — sempre confirme o status direto na API da Efí.** |
| 4 | **Filter** | Só continua se `{{3.status}} = CONCLUIDA`. |
| 5 | **HTTP → Make a request** | `POST {SUPABASE_URL}/rest/v1/rpc/reserva_id_por_txid`<br>Headers: `apikey: {SERVICE_ROLE_KEY}`, `Authorization: Bearer {SERVICE_ROLE_KEY}`<br>Body: `{"p_txid": "{{2.txid}}"}`<br>Resolve qual reserva esse pagamento pertence — a Efí não devolve `external_reference` como outros gateways, então correlacionamos pelo `txid` salvo no Scenario 1. |
| 6 | **HTTP → Make a request** | `POST {SUPABASE_URL}/rest/v1/rpc/confirmar_pagamento`<br>Headers: `apikey: {SERVICE_ROLE_KEY}`, `Authorization: Bearer {SERVICE_ROLE_KEY}`<br>Body: `{"p_gateway_txid": "{{2.endToEndId}}", "p_reserva_id": "{{5}}", "p_payload": {{3}}}` |
| 7 | **Filter** | Só continua se `{{6.sucesso}} = true`. Se `false` (motivo `ja_processado`), o scenario para aqui — proteção contra notificação duplicada. |
| 8 | **HTTP → Make a request** (opcional, WhatsApp) | Chama seu endpoint Z-API/Baileys existente enviando confirmação pro WhatsApp da reserva. |

---

## Confirmação manual (fallback PIX estático)

A landing page mostra a chave PIX do cliente como alternativa dentro do modal de
pagamento (`config.js` → `PIX_CHAVE_FALLBACK`), com um link que já abre o WhatsApp do
cliente — mantido como rede de segurança mesmo com PIX universal via Efí (ex: se o webhook
atrasar ou a Efí cair). Quem usa esse caminho não passa pelo webhook automático — o
cliente confirma o comprovante manualmente e roda isto no SQL Editor do Supabase:

```sql
select confirmar_pagamento(
  p_gateway_txid := 'manual-' || gen_random_uuid()::text,
  p_reserva_id := '<uuid da reserva, achar em reservas where numero = X and status = ''pendente''>',
  p_payload := '{"origem": "pix_manual"}'::jsonb
);
```

Para um pedido (vários números na mesma compra, ver Scenario 4 abaixo), o
equivalente é:

```sql
select confirmar_pagamento_pedido(
  p_gateway_txid := 'manual-' || gen_random_uuid()::text,
  p_pedido_id := '<uuid do pedido, achar em pedidos where cpf = ''...'' and status = ''pendente''>',
  p_payload := '{"origem": "pix_manual"}'::jsonb
);
```

---

## Scenario 4 — Reservar Pedido + Gerar Cobrança PIX (vários números numa compra)

**Dispara quando:** o comprador seleciona 2+ números no modo "seleção múltipla" da
landing page e envia o formulário. Cenário novo, separado do Scenario 1 — não
altera nada do fluxo de número único, que continua chamando o Scenario 1 normalmente.

Pré-requisito: rodar a parte nova de `supabase/schema.sql` (tabela `pedidos` +
funções `reservar_pedido`, `vincular_txid_efi_pedido`, `pedido_id_por_txid`,
`confirmar_pagamento_pedido`, `status_pedido`).

| # | Módulo | Configuração |
|---|--------|--------------|
| 1 | **Webhooks → Custom webhook** | Cria o webhook, copia a URL gerada pra `config.js` → `MAKE_WEBHOOK_RESERVAR_PEDIDO`. Body esperado: `{ numeros: [11, 12], nome, whatsapp, cpf }` |
| 2 | **HTTP → Make a request** | `POST {SUPABASE_URL}/rest/v1/rpc/reservar_pedido`<br>Headers: `apikey: {SERVICE_ROLE_KEY}`, `Authorization: Bearer {SERVICE_ROLE_KEY}`, `Content-Type: application/json`<br>Body: `{"p_numeros": {{1.numeros}}, "p_nome": "{{1.nome}}", "p_whatsapp": "{{1.whatsapp}}", "p_cpf": "{{1.cpf}}", "p_minutos": 15}` |
| 3 | **Router** | Ramo A: `{{2.sucesso}} = false` → passo 8. Ramo B: `{{2.sucesso}} = true` → passo 4. |
| 4 | **HTTP → Make a request** (Ramo B) | `POST {EFI_PROXY_URL}/api/efi/oauth/token` (mesmo proxy mTLS já usado no Scenario 1 PRODUCAO — não precisa de certificado configurado no Make, o proxy segura o cert) |
| 5 | **HTTP → Make a request** (Ramo B) | `POST {EFI_PROXY_URL}/api/efi/v2/cob`<br>Body: `{"calendario": {"expiracao": 900}, "devedor": {"cpf": "{{1.cpf}}", "nome": "{{1.nome}}"}, "valor": {"original": "{{formatNumber(length(1.numeros) * 10; 2; "."; "")}}"}, "chave": "{EFI_CHAVE_PIX}", "solicitacaoPagador": "Rifa Formatura - {{length(1.numeros)}} números"}` |
| 6 | **HTTP → Make a request** (Ramo B) | `POST {SUPABASE_URL}/rest/v1/rpc/vincular_txid_efi_pedido`<br>Body: `{"p_pedido_id": "{{2.pedido_id}}", "p_txid": "{{5.txid}}"}` |
| 7 | **Webhooks → Webhook response** (Ramo B) | Status 200. Body: `{"sucesso": true, "pedido_id": "{{2.pedido_id}}", "copia_cola": "{{5.pixCopiaECola}}"}` |
| 8 | **Webhooks → Webhook response** (Ramo A) | Status 200. Body: `{"sucesso": false, "motivo": "{{2.motivo}}", "numeros_indisponiveis": {{2.numeros_indisponiveis}}}` |

**Confirmação de pagamento de pedidos:** não criamos um Scenario 5 separado pra
isso. `efi-proxy/api/reconcile.js` (rede de segurança já existente, rodando via
Scheduler no Make a cada 25 min) foi estendido pra também varrer `pedidos`
pendentes com `efi_txid`, checar `GET /v2/cob/:txid` e chamar
`confirmar_pagamento_pedido` — mesma lógica de hoje pra número único, agora
cobrindo pedidos também. O Scenario 2 ("Confirmar Pagamento Efi PRODUCAO", que
recebe o webhook de pagamento real da Efí) **não foi alterado** — continua só
confirmando número único. Isso significa que pedidos são confirmados no mesmo
ritmo que números avulsos já são hoje (a cada ciclo do `reconcile.js`), já que
o webhook real da Efí segue não entregando eventos de pagamento (ver seção
"Payment webhook still not delivering" na memória do projeto).

---

## Scenario 3 (opcional, não bloqueante) — Auditoria de reservas expiradas

O estoque (`numeros`) já se autolimpa: a função `reservar_numero` libera números vencidos
sozinha, via `reservado_ate < now()` na cláusula WHERE. Este scenario é só cosmético, pra
manter a tabela `reservas` com status correto em relatórios — não afeta a correção do
sistema se atrasar ou falhar.

| # | Módulo | Configuração |
|---|--------|--------------|
| 1 | **Scheduler** | A cada 15 minutos. |
| 2 | **HTTP → Make a request** | `PATCH {SUPABASE_URL}/rest/v1/reservas?status=eq.pendente&expira_em=lt.{{now}}`<br>Headers: `apikey: {SERVICE_ROLE_KEY}`, `Authorization: Bearer {SERVICE_ROLE_KEY}`<br>Body: `{"status": "expirada"}` |

---

## Credenciais necessárias

| Credencial | Onde conseguir | Usada em |
|---|---|---|
| `SUPABASE_URL` | Painel do Supabase → Project Settings → API | Scenarios 1, 2, 3 e `config.js` (sem a service key) |
| `SUPABASE_SERVICE_ROLE_KEY` | Painel do Supabase → Project Settings → API (chave secreta, nunca no front-end) | Scenarios 1, 2, 3 |
| `SUPABASE_ANON_KEY` | Painel do Supabase → Project Settings → API (chave pública) | `config.js` da landing page |
| `EFI_CLIENT_ID` / `EFI_CLIENT_SECRET` | Painel Efí → API Pix → Aplicações | Autenticação (oauth/token) |
| Certificado `.p12` | Painel Efí → API Pix → Meus Certificados | mTLS em toda chamada à API Efí |
| `EFI_CHAVE_PIX` | Chave aleatória criada direto no app do Efí pela cliente (não é a chave do Nubank — chave PIX só pode estar vinculada a um banco/PSP por vez) | Scenarios 1 e 2 |

## Credenciais necessárias — nota sobre `EFI_CHAVE_PIX`

Diferente de `EFI_CLIENT_ID`/`EFI_CLIENT_SECRET`/`.p12` (segredos de API, nunca no chat),
a chave PIX em si não é secreta — é o mesmo tipo de dado que já aparece publicamente num
QR Code. Ainda assim, siga o padrão do projeto: a cliente cola o valor direto em `.env`
(`EFI_CHAVE_PIX=...`), sem passar pelo chat.

## Checklist antes de ir ao ar (gate do @qa)

- [x] **Testar o certificado mTLS no módulo HTTP do Make primeiro.** Funciona colando o PEM direto (ver nota no topo do doc).
- [x] Testar o fluxo inteiro no ambiente de homologação da Efí (`pix-h.api.efipay.com.br`) — reserva + cobrança + confirmação testados ponta a ponta em 03/09.
- [ ] Confirmar que a chave PIX aleatória cadastrada na Efí está ativa e corresponde à conta certa (testar com um pagamento de R$0,01 real em produção antes do lançamento)
- [x] Testar dois cliques simultâneos no mesmo número (duas abas) → confirmado via `reservar_numero` direto: só um dos dois consegue, sem inconsistência.
- [x] Testar notificação duplicada da Efí (reenviar manualmente o mesmo webhook) → confirmado que não duplica (idempotência por `gateway_txid`). Notificação automática por WhatsApp ainda não construída.
- [x] Testar pagamento feito 1 minuto depois da cobrança expirada → **achou e corrigiu um bug real**: `confirmar_pagamento` sobrescrevia o número com o comprador ERRADO se ele já tivesse sido reservado por outra pessoa. Agora retorna `motivo: 'numero_realocado_revisar_manualmente'` sem tocar em `numeros` (pagamento fica registrado em `pagamentos` pra estorno manual). **Follow-up:** hoje esse motivo não dispara alerta nenhum — vale adicionar uma notificação (WhatsApp/e-mail) pro organizador quando isso acontecer, pra não passar despercebido.
- [ ] Manter a chave PIX estática do cliente visível na landing como alternativa manual
- [ ] No dia do sorteio: conciliar extrato do Nubank × tabela `pagamentos` do Supabase, zero divergência
