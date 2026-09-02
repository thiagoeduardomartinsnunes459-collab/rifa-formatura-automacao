# Próximo passo — testar o scenario e configurar os filtros do Router

## ⚠️ BLOQUEADO (02/09, sessão de debug) — webhook retorna 410 mesmo com tudo certo

Depois de configurar tudo corretamente (ver checklist abaixo, todos os itens confirmados
✅), toda chamada POST pro webhook — tanto via `curl`/fetch quanto pela própria landing
page, de duas redes diferentes — retorna:

```
HTTP 410 — "There is no scenario listening for this webhook."
```

**O que já foi verificado e confirmado correto** (então não é isso):
- ✅ Webhook (módulo 2) e HTTP (módulo 3) estão de fato conectados no canvas (não só
  visualmente encostados — a linha pontilhada de conexão real está lá; isso foi um bug
  real que corrigimos no caminho, o Webhook estava desconectado do flow)
- ✅ Scenario foi salvo (`Ctrl+S` — havia mudanças não salvas que também contribuíam pro
  problema, mas não resolveram sozinhas)
- ✅ Scenario está **Active** (toggle ligado em `/2466751/scenarios/6130107`, fora do
  editor)
- ✅ O webhook `reservar-numero-rifa` (`.../vf1kke3goyndyhmbu12vvwcgn6rpas00`) está
  confirmado como pertencente a este scenario específico (via menu "..." → Scenario na
  página `/2466751/hooks`)
- ✅ Nenhuma requisição aparece no Histórico do scenario — nem como sucesso, nem como
  erro — sugerindo que a rejeição acontece antes mesmo de virar uma tentativa de execução
  registrada (não é um erro de lógica dentro do scenario, é algo na camada de "está
  escutando ou não")

**Descartado:** IP bloqueado (testado de dois navegadores/redes diferentes, mesmo erro).

**Limpeza pendente:** existe um webhook duplicado órfão chamado `rifa-reservar-numero`
(URL diferente, `.../3wejsc3nqwy94nukgr2yfxafjo3l0qhd`) criado durante as tentativas —
não está causando o bug, mas vale apagar depois pra não confundir.

**Recomendação:** abrir chamado com o suporte do Make citando especificamente "410 - no
scenario listening" com scenario Active e webhook confirmadamente vinculado — isso parece
comportamento anômalo de conta/plano, não erro de configuração.

---

## Pré-requisitos antes de começar

1. `SUPABASE_SERVICE_ROLE_KEY` preenchida no `.env` (pega no painel do Supabase →
   Project Settings → API → chave secreta, diferente da anon).
2. Essa mesma chave colada nos headers `apikey` e `Authorization` do módulo **3** (HTTP)
   no scenario do Make (abre o módulo → Headers → cola nos dois campos "Value" que
   estão vazios). O `Authorization` precisa do prefixo `Bearer `, ex: `Bearer eyJhbGci...`.
3. `landing/config.js` com `MOCK_MODE: false` (já deve estar assim).

## Passo a passo do teste

1. No Make, abre o scenario **"Rifa - Reservar Numero + Gerar PIX"**.
2. Clica em **"Run once"** (canto inferior esquerdo). O scenario fica "escutando" —
   os módulos ganham uma borda tracejada/animação indicando que estão aguardando dados.
3. Em outra aba, abre a landing page (local ou publicada) e escolhe um número disponível.
4. Preenche nome, WhatsApp e CPF de teste, e envia o formulário.
5. Volta pro Make — o scenario deve ter processado a execução automaticamente (o webhook
   recebeu o POST, chamou o Supabase). Se dentro de uns 10-15 segundos nada aparecer,
   confirma se o `MAKE_WEBHOOK_RESERVAR` no `config.js` bate com a URL do webhook do Make.
6. Clica em cada módulo (Webhook, depois HTTP) — deve aparecer um ícone de "bolha" ou
   "resultado" mostrando os dados reais que passaram por ali. Se o módulo 3 (HTTP) mostrar
   erro 401/403, é sinal de que as chaves do passo 2 acima estão erradas ou não foram
   salvas.

## Configurando os filtros do Router (só depois do teste funcionar)

7. Clica na rota de cima (a mais próxima do topo) do Router pra abrir "Set up a filter".
8. No campo **Condition**, clica nele — agora que existe uma execução real, o seletor de
   campos deve mostrar os campos de verdade da resposta do módulo 3, incluindo `sucesso`
   dentro da estrutura de dados retornada. Seleciona esse campo em vez de digitar à mão.
9. Operador: **Boolean: Equal to** (ou "Text operators" se vier como texto) → valor `false`.
10. Rótulo (Label): `Reserva falhou`.
11. Salva. Repete pra rota de baixo, mas com valor `true` e rótulo `Reserva OK`.

## O que fazer se travar

- **Módulo 3 sem executar / erro genérico de conexão**: confirma que a URL no `config.js`
  é exatamente a mesma do webhook criado no Make (sem espaço, sem barra a mais no final).
- **Erro 401/403 no módulo 3**: as chaves `apikey`/`Authorization` do header estão erradas,
  vazias, ou sem o prefixo `Bearer ` no Authorization.
- **Seletor de campos ainda não mostra `sucesso` depois do teste**: clica direto no módulo
  3 → deve ter um pequeno ícone de "bolha"/histórico no canto — clica nele pra confirmar
  que a execução realmente retornou dados. Se retornou vazio, o problema está na função
  `reservar_numero` do Supabase, não no Make.

Quando os dois filtros estiverem salvos, me avisa — o próximo passo depois disso é
adicionar o módulo de resposta do webhook (Ramo A, erro) e preparar o resto pra quando as
credenciais da Efí chegarem.
