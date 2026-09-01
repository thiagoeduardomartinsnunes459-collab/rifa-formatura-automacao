# Gerar token de API do Make

> Confiança MEDIA nos nomes exatos de menu — pode ter mudado desde a última vez que
> verifiquei. A lógica (perfil → API → criar token → escopos → copiar uma vez só) tende a
> se manter mesmo que os rótulos mudem.

## Passo a passo

1. Logar em **make.com** (o mesmo login usado pra montar os scenarios).
2. Clicar no **ícone do seu perfil** (canto superior direito).
3. Procurar a aba/seção **"API"** dentro de "Profile" / configurações da conta.
4. Clicar em **"Add token"** / **"Criar token"**.
5. Dar um nome (ex: `rifa-formatura-claude`).
6. **Marcar os escopos:**
   - `scenarios:read` e `scenarios:write` (obrigatórios — é o que permite eu criar/editar os scenarios)
   - `connections:read` (pra eu conseguir referenciar a connection da Efí que vocês criarem na chamada, sem precisar ver o conteúdo dela)
   - `hooks:read` e `hooks:write` (pra criar o webhook trigger do Scenario 1)
7. Confirmar. **O token só aparece uma vez** — copiar na hora, não dá pra ver de novo depois (só gerar um novo se perder).

## Onde anotar o "zone" da conta

A API do Make é dividida por região — a URL base muda conforme isso. Olhar a barra de
endereço do navegador enquanto estiver logada no Make: vai ser algo como
`eu1.make.com`, `eu2.make.com`, `us1.make.com` ou `us2.make.com`. Anotar esse prefixo
(ex: `eu2`) — é ele que entra na URL de toda chamada de API (`https://{zone}.make.com/api/v2/...`).

## Como me passar o token (sem colar no chat)

Mesma lógica de segurança que já usamos pra credencial da Efí — token de API não deveria
ficar solto em texto de chat. Cria um arquivo `.env` na raiz de
`rifa-formatura-automacao/` (esse arquivo já devia estar no `.gitignore` se algum dia isso
virar um repositório git) com:

```
MAKE_API_TOKEN=cole_o_token_aqui
MAKE_ZONE=eu2
```

Eu leio essas variáveis via Bash na hora de chamar a API — não preciso que você me diga o
valor em texto na conversa.

## O que eu faço com isso

Depois de ter o token, eu crio via API: o webhook trigger do Scenario 1, os módulos HTTP
que chamam as funções do Supabase (`reservar_numero`, `vincular_txid_efi`,
`confirmar_pagamento`), o router, os filtros, e a formatação da resposta do webhook.

**O que fica pendente mesmo com o token:** os módulos HTTP que chamam a API da Efí
precisam de uma **Connection** já existente na conta do Make com o certificado — essa
parte continua sendo feita na chamada de tela com a Adriana (ver
`passo-a-passo-conta-efi.md`). Eu deixo esses módulos prontos, referenciando a connection
pelo nome/ID, só falta ela existir.
