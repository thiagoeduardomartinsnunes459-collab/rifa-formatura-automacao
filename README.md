# Rifa Formatura em Direito — Automação de Venda

Automação de venda de números de rifa com escolha de número na grade, cobrança PIX via
Efí (dinheiro cai direto na conta Nubank do cliente, sem carteira intermediária), e
orquestração no Make.com. Nasceu de um debate multi-agente (arquitetura, produto, ROI,
QA, dados) que apontou o problema real do fluxo manual: concorrência pelo mesmo número
sem nenhuma trava atômica. O gateway trocou duas vezes (Mercado Pago → PicPay → Efí)
por indecisão do cliente sobre onde o dinheiro deveria cair — a camada de dados
(Postgres/Supabase) foi desenhada pra ser agnóstica a gateway desde o início, então só a
integração HTTP dos scenarios do Make mudou a cada troca. Ver `docs/MAKE-SETUP.md` para
o motivo de cada decisão técnica.

## Estrutura

```
rifa-formatura-automacao/
├── supabase/
│   └── schema.sql          # Tabelas + funções reservar_numero / confirmar_pagamento
├── landing/
│   ├── index.html           # Grade de números + modais de compra/PIX
│   ├── app.js                # Lógica: carrega grid, reserva, exibe PIX, faz polling
│   ├── style.css
│   └── config.js             # Chaves públicas (preencher antes de publicar)
├── docs/
│   └── MAKE-SETUP.md        # Roteiro exato dos scenarios do Make
└── README.md
```

## Modo mock (demo sem backend nenhum)

`landing/config.js` → `MOCK_MODE: true` (é o valor padrão agora). Com isso, a landing
page inteira funciona sem Supabase nem Efí configurados — a grade usa uma lista falsa em
memória, "gerar cobrança" devolve um QR/código fake, e o pagamento confirma sozinho depois
de 5 segundos. Serve pra:

- Mostrar o fluxo completo pro cliente enquanto a conta Efí não é aprovada
- Testar a interface (grid, modal, responsividade) sem depender de nada externo

**Trocar pra `MOCK_MODE: false` só quando `SUPABASE_URL`, `SUPABASE_ANON_KEY` e
`MAKE_WEBHOOK_RESERVAR` forem os valores reais** — senão a página tenta chamar serviços
que não existem e quebra.

## Ordem de setup

1. **Supabase** — cria um projeto novo, roda `supabase/schema.sql` inteiro no SQL Editor.
   Confirma que a tabela `numeros` ficou com 1000 linhas (`select count(*) from numeros`).
2. **Habilitar Realtime** na tabela `numeros` (Database → Replication → marca `numeros`) —
   é o que faz a grade atualizar sozinha na tela de todo mundo sem re-polling manual.
3. **Efí (ex-Gerencianet)** — abre/valida a conta do cliente, gera as credenciais de API
   (`client_id`/`client_secret` + certificado `.p12`) em API Pix → Aplicações. Cadastra a
   chave PIX do Nubank como chave de recebimento. **Testa primeiro se o Make aceita o
   certificado mTLS** (ver aviso no topo do `docs/MAKE-SETUP.md` — é o maior risco técnico
   desta escolha de gateway) antes de montar o resto.
4. **Make.com** — monta os dois scenarios seguindo `docs/MAKE-SETUP.md` passo a passo.
   Copia a URL do webhook do Scenario 1.
5. **Landing page** — preenche `landing/config.js` com `SUPABASE_URL`, `SUPABASE_ANON_KEY`
   e a URL do webhook do Make. Publica em qualquer hospedagem estática (Vercel, Netlify,
   GitHub Pages) — são só 3 arquivos estáticos, sem build.
6. Roda o checklist de "antes de ir ao ar" no final do `docs/MAKE-SETUP.md`.

## Por que essa arquitetura

- **Sem Sheets/Airtable como estoque.** Nenhum dos dois tem update condicional — dois
  compradores no mesmo número em pico de tráfego corrompiam o dado. Postgres com
  `UPDATE ... WHERE status='disponivel'` resolve isso numa cláusula.
- **Sem cron separado pra liberar número expirado.** O `calendario.expiracao` da cobrança
  na Efí é o mesmo prazo da reserva no Supabase — quando expira, a própria função
  `reservar_numero` libera o número na próxima tentativa (`reservado_ate < now()` no WHERE).
- **Webhook idempotente.** `gateway_txid` é `UNIQUE` na tabela `pagamentos` — reenvio de
  notificação da Efí vira no-op, não duplica confirmação nem mensagem de WhatsApp.
- **Correlação por `efi_txid`, não por `external_reference`.** A Efí não devolve um campo
  de referência externa como Mercado Pago/PicPay — por isso a tabela `reservas` guarda o
  `txid` da cobrança assim que ela é criada, e o webhook usa esse `txid` pra achar a
  reserva certa (`reserva_id_por_txid`).

## O que ficou de fora do escopo (por decisão, não esquecimento)

- Confirmação por WhatsApp é opcional (Scenario 2, passo 7) — o @pm levantou risco de ban
  em número novo disparando muitas mensagens em pico. Comece só com a tela de sucesso na
  landing page; adicione WhatsApp depois se sobrar tempo antes do sorteio.
- Não existe painel administrativo — acompanhamento é direto nas tabelas do Supabase
  (Table Editor) até que valha a pena construir um.
