# Configuração dos Scenarios no Make.com

Make não tem uma API de scripting confiável pra montar scenarios do zero — os módulos
precisam ser conectados manualmente na interface. Este guia é o roteiro exato pra montar
os dois scenarios que fecham o fluxo da Versão A (grade de números + Postgres/Supabase),
usando **Efí (ex-Gerencianet)** como gateway.

**Por que Efí e não PicPay/Mercado Pago:** o cliente quer o dinheiro caindo direto na
própria conta Nubank, não numa carteira intermediária que precisa de saque manual depois.
A Efí permite cobrança PIX vinculada à chave PIX real do lojista (a mesma chave já
registrada no Nubank) — o valor cai direto na conta, sem intermediário reter. Isso também
resolve de vez a dúvida de compatibilidade de QR que tínhamos com o PicPay: cobrança Efí
gera um PIX BR Code padrão, aceito por qualquer banco.

> ✅ **Certificado mTLS testado e confirmado (02/09).** Rodamos `testar-efi.ps1` (na raiz
> do projeto) com `curl --cert-type P12` direto contra
> `https://pix-h.api.efipay.com.br/oauth/token` (homologação) e recebemos `200` com
> `access_token` real, escopos `cob.write cob.read webhook.write`. Client ID, Client
> Secret e o `.p12` estão todos corretos. **Detalhe importante que corrigimos:** o corpo
> precisa ser `application/x-www-form-urlencoded` (`grant_type=client_credentials`), **não**
> JSON — a doc anterior assumia JSON errado.
>
> **O que ainda não foi testado:** se o módulo HTTP do **Make** (não o `curl`) aceita
> certificado `.p12` do mesmo jeito via a opção "Client Certificate" em Connections — isso
> depende do plano da conta e ainda está bloqueado pelo bug do webhook (ver
> `proximo-passo-teste-make.md`). Quando o Make voltar a funcionar, usar
> `x-www-form-urlencoded` no módulo de autenticação, replicando exatamente o `testar-efi.ps1`.

Pré-requisito: rode `supabase/schema.sql` no projeto Supabase antes de configurar
qualquer scenario aqui — os módulos abaixo dependem das funções `reservar_numero` e
`confirmar_pagamento` já existirem (o schema já inclui o campo `cpf`, exigido pela Efí em
`devedor.cpf`).

## Status atual (já construído no Make)

O scenario **"Rifa - Reservar Numero + Gerar PIX"** já existe no Make com:

- ✅ Módulo **2** — Webhook trigger (`Custom webhook`), URL:
  `https://hook.us2.make.com/vf1kke3goyndyhmbu12vvwcgn6rpas00` (já está em `config.js`)
- ✅ Módulo **3** — HTTP call pra `reservar_numero`, com os 3 headers criados
  (`Content-Type` preenchido, `apikey` e `Authorization` **vazios — preencher com a
  `SUPABASE_SERVICE_ROLE_KEY` do `.env`**) e o corpo já mapeado corretamente
- ✅ Router adicionado logo depois, com 2 rotas vazias, esperando os filtros

**Atenção aos números dos módulos:** o Make não numera os módulos como 1, 2, 3 na ordem
que você imagina — o Webhook virou módulo **2** e o HTTP módulo **3** (não 1 e 2), porque
o Make incrementa o ID a cada tentativa, mesmo quando você apaga e refaz um módulo. Sempre
que for referenciar um campo de outro módulo (`{{N.campo}}`), confirme o número real
olhando o rótulo abaixo do ícone do módulo no canvas (ative "Show module ID" com botão
direito no canvas vazio, se não estiver visível) — não assuma pela ordem visual.

**Por que os filtros das 2 rotas do Router ainda não foram configurados:** o seletor de
campos do Make só sugere campos de módulos cujo formato ele já "viu" — e o Webhook nunca
recebeu uma execução de verdade ainda (só um teste manual que não ficou registrado como
amostra). Sem isso, não dá pra confirmar com segurança a sintaxe exata do caminho até
`sucesso` dentro da resposta da função `reservar_numero` (ela retorna uma tabela/array,
então pode ser `{{3.Data[1].sucesso}}` ou uma variação disso — não testei contra dado
real). **Próximo passo recomendado:** clicar em **"Run once"** no scenario, disparar um
teste real pela landing page (com `MOCK_MODE: false`), e depois configurar os filtros —
nesse ponto o seletor de campos do Make vai sugerir `sucesso` diretamente, sem adivinhação.

- Rota de cima (route 1): filtro `{{3.Data[1].sucesso}} = false` (ou o caminho certo que
  aparecer depois do teste) → módulo de resposta de erro do Webhook
- Rota de baixo (route 2): filtro `= true` → segue pros módulos da Efí (ainda não
  construídos, aguardando as credenciais da chamada com a cliente)

**Pré-requisito adicional:** confirmar se a conta Efí do cliente é Pessoa Física (CPF) ou
Pessoa Jurídica — a Efí atende os dois, mas o cadastro e a chave PIX vinculada mudam
conforme o tipo de conta. Como isso é uma rifa pessoal, é provável que seja conta PF.

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
| `EFI_CHAVE_PIX` | A própria chave PIX do cliente, já registrada no Nubank e cadastrada como chave de recebimento na conta Efí | Scenarios 1 e 2 |

## Checklist antes de ir ao ar (gate do @qa)

- [ ] **Testar o certificado mTLS no módulo HTTP do Make primeiro.** Se não funcionar, construir o proxy de fallback antes de continuar — é bloqueante pra tudo o resto.
- [ ] Testar o fluxo inteiro no ambiente de homologação da Efí (`pix-h.api.efipay.com.br`) antes de usar chaves de produção
- [ ] Confirmar que a chave PIX cadastrada na Efí é exatamente a mesma do Nubank do cliente (testar com um pagamento de R$0,01 real)
- [ ] Testar dois cliques simultâneos no mesmo número (duas abas) → só um deve conseguir reservar
- [ ] Testar notificação duplicada da Efí (reenviar manualmente o mesmo webhook) → não deve duplicar confirmação nem WhatsApp
- [ ] Testar pagamento feito 1 minuto depois da cobrança expirada → deve cair na fila de exceção, não sumir
- [ ] Manter a chave PIX estática do cliente visível na landing como alternativa manual
- [ ] No dia do sorteio: conciliar extrato do Nubank × tabela `pagamentos` do Supabase, zero divergência
