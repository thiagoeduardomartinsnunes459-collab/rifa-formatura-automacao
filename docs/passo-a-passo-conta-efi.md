# Passo a passo — Abrir conta na Efí (pra mandar pro cliente)

> Baseado no fluxo público de cadastro da Efí — a tela pode ter mudado um pouco desde a
> última vez que verifiquei. Se algo aparecer diferente do descrito aqui, seguir o que
> está na tela é mais confiável do que este roteiro (confiança MEDIA nos nomes exatos de
> botão/menu, ALTA na sequência geral do processo).

## Atualização: a cliente já tem conta na Efí (pulamos a Parte 1 inteira)

O que parecia ser "o app do banco dela com Efí integrado" era, na verdade, **o próprio
app da Efí** — ela já é cliente pessoa física lá ("Boas-vindas, Adriana"). O menu "Efí
para negócios" leva a uma tela com duas opções:

1. **"Continuar com o upgrade da conta"** (Efí Pro) — mesma conta, adiciona recursos de
   negócio, sem perder dados.
2. **"Abrir uma nova conta para gerir meu negócio"** — conta separada, do zero.

**Recomendação: opção 1 (upgrade).** Confiança MEDIA sobre qual das duas realmente
destrava a seção de API Pix/Aplicações (não tenho certeza se fica só na conta pessoal, só
no Pro, ou só na conta de negócio nova) — mas abrir conta nova pra um caso de uso
individual como esse não parece necessário, e o upgrade é descrito como aditivo.

Como a cobrança PIX da Efí pode apontar pra qualquer chave PIX do CPF dela mesmo que a
chave "more" em outro banco (o Nubank, no caso), a escolha entre upgrade e conta nova não
deveria afetar o plano de manter a chave do Nubank como destino do dinheiro.

**Status: ✅ upgrade pra Efí Pro feito** — confirmado que é mesmo gratuito e sem análise
([sejaefi.com.br/efi-bank/efi-pro](https://sejaefi.com.br/efi-bank/efi-pro),
[comunidade sobre acesso a APIs no Pro](https://comunidade.sejaefi.com.br/discussao/acesso-apis-contas-cnpj-cpf-efi-pro-38)).
Só o Pro (ou Efí Empresas) dá acesso à API — a conta pessoal comum não tem essa opção.

**Próximo passo agora:** procurar no menu por **"API Pix"** ou **"Aplicações"** — é ali
que ficam os passos 9-11 da Parte 3 abaixo (Client ID, Client Secret, certificado). Pedir
print de onde isso aparecer.

Como ela já é cliente aprovada, a Parte 1 abaixo (cadastro do zero em efipay.com.br) fica
só como referência caso algo dê errado — não deveria ser necessária.

## Parte 1 — O cliente faz sozinho (cadastro e aprovação, caminho alternativo)

1. Acessar **efipay.com.br** e procurar o botão de **"Abrir conta"** ou **"Cadastre-se"**.
2. Escolher **Pessoa Física** (é o tipo certo pra CPF, não CNPJ).
3. Preencher os dados pedidos: CPF, nome completo, e-mail, telefone, e provavelmente um
   documento com foto (RG ou CNH) pra verificação de identidade.
4. Enviar o cadastro e aguardar aprovação. **Isso pode levar de algumas horas até 1-2 dias
   úteis** — é análise da própria Efí, não tem como acelerar. Por isso vale abrir o quanto
   antes, pensando no prazo do sorteio (10/02).
5. Confirmar e-mail/telefone se for pedido (link de confirmação por e-mail é comum).

## Parte 2 — Depois de aprovado: cadastrar a chave PIX

6. Entrar no painel da Efí (geralmente em **app.efipay.com.br** ou o link que vier no
   e-mail de aprovação).
7. Procurar a seção de **Pix** ou **Minha Conta → Chaves Pix**.
8. Cadastrar a chave PIX que já é do Nubank dele (`55997331063`) como a chave de
   recebimento. Normalmente pede uma confirmação (código por SMS ou e-mail).

## Parte 3 — A parte técnica (fazer junto, não mandar o cliente sozinho)

9. Dentro do painel, procurar **"API Pix"** ou **"Aplicações"** / **"Integrações"**.
10. Criar uma nova aplicação — isso gera um **Client ID** e um **Client Secret**.
11. Baixar o **certificado** (arquivo `.p12`) daquela mesma tela.

### Detalhando o passo 10 — criar a aplicação

> Confiança MEDIA nos nomes exatos de menu/botão abaixo — é o fluxo geral conhecido do
> painel da Efí, mas pode ter mudado. Se a tela dele mostrar nomes diferentes, siga o que
> está na tela; a lógica (nome → escopo Pix → ambiente → credenciais) tende a se manter.

1. No menu do painel, procurar algo como **"Minhas Aplicações"** ou **"API"** (às vezes
   dentro de um menu maior chamado "Integrações" ou "Ferramentas").
2. Clicar em **"Nova Aplicação"** / **"Criar Aplicação"**.
3. Dar um nome pra ela — qualquer nome serve pra identificar depois, ex: `rifa-formatura`.
4. **Marcar o escopo/produto "Pix"** na lista de APIs disponíveis (a Efí também oferece
   boleto, cartão etc. — só marcar Pix é o que importa aqui). Normalmente aparecem
   permissões dentro do escopo Pix (tipo `cob.write`, `cob.read`, `webhook.write`,
   `pix.read`) — se puder escolher individualmente, marcar todas as de Pix.
5. **Escolher o ambiente: Homologação primeiro.** A Efí trata produção e homologação como
   aplicações/certificados separados — crie a de homologação agora pra testar sem
   risco, e repita esse mesmo passo 10 depois, já em produção, só quando o teste em
   homologação funcionar de ponta a ponta.
6. Confirmar a criação. A tela deve mostrar o **Client ID** e o **Client Secret** — é
   nesse momento que você cola direto no Make, como descrito na seção da chamada abaixo.
7. Ainda na mesma aplicação (ou numa seção separada tipo **"Meus Certificados"**), gerar e
   baixar o certificado `.p12` correspondente a esse mesmo ambiente (homologação). O
   download costuma disparar direto, sem precisar definir senha própria pro arquivo.
8. **Repetir os passos 2-7 depois, criando a versão de produção**, só quando o fluxo em
   homologação já tiver sido testado com sucesso (webhook chegando, cobrança confirmando
   no Supabase etc.) — assim você troca só as credenciais/certificado no Make, sem mexer
   na lógica dos scenarios.

**Recomendação:** os passos 9-11 envolvem credenciais que dão acesso à conta de
pagamento dele — não é ideal que ele faça isso sozinho e mande os arquivos/senhas por
WhatsApp em texto puro. Melhor marcar uma chamada de tela rápida pra fazer essa parte
junto.

### Como a chamada funciona, na prática

**Antes da chamada**
- **Confirmado: a "Área do integrador" (criar aplicação, gerar credenciais, baixar
  certificado) só existe na plataforma web da Efí — não existe no app do celular.** O
  próprio app mostra o aviso "Disponível na plataforma web" quando se toca em API. Ou
  seja: **ela precisa estar num computador** pra essa chamada, não só com o celular em
  mãos. Confirmar isso antes de marcar horário.
- Ela vai precisar logar em **sejaefi.com.br** (ou o link de login que aparecer a partir
  daí) com o mesmo usuário/senha da conta Efí Pro do celular.
- Você já com o Make aberto, logado, na tela de criar uma nova conexão HTTP (Connections
  → Add → HTTP com Client Certificate). É pra essa tela que as credenciais vão direto.
- Confirma com o cliente que a chave Pix do Nubank já está cadastrada como chave de
  recebimento na conta Efí (Parte 2 deste guia) — pode ser feito pelo próprio app,
  antes da chamada, pra não gastar tempo da chamada com isso.
- Ferramenta: Google Meet ou WhatsApp vídeo, qualquer uma que tenha compartilhamento de
  tela. Não precisa de nada além disso.

**Durante a chamada — ordem dos passos**
1. **Cliente compartilha a tela dele**, logado no painel da Efí, na seção
   Aplicações/API Pix.
2. Você guia ele a clicar em "criar nova aplicação" (ou nome equivalente na tela dele).
3. Quando aparecer o **Client ID** e o **Client Secret**: você anota direto na tela do
   Make (não copia pra bloco de notas, WhatsApp, ou qualquer lugar intermediário) — cola
   direto nos campos da conexão HTTP que você já tinha aberto.
4. Quando o **certificado `.p12`** for baixado: peça pro cliente, ainda com a tela
   compartilhada, **fazer upload do arquivo direto no campo de certificado da conexão do
   Make** (se o Make permitir upload durante compartilhamento de tela de quem está do
   outro lado — senão, ele manda o arquivo por um canal privado combinado na hora, tipo
   Google Drive com link que expira, e você apaga o arquivo do Drive assim que importar
   no Make).
5. Depois de configurada a conexão, faça um teste rápido ali mesmo na chamada: chamar o
   endpoint de autenticação (`POST /oauth/token`) só pra confirmar que o certificado foi
   aceito. Se dar erro de certificado aqui, é o momento de descobrir — não depois, no meio
   de montar os scenarios.

**Depois da chamada**
- Cliente apaga o arquivo `.p12` da pasta de Downloads dele (ou de onde tiver salvo) —
  não precisa guardar cópia, quem precisa dele daqui pra frente é só o Make.
- Você confirma que a conexão ficou salva no Make e funcionando — as credenciais ficam
  armazenadas lá, dentro do Make (que criptografa o que está salvo em Connections), não
  soltas em nenhum chat ou arquivo seu.

Se o teste do certificado no passo 5 falhar, é o sinal de "o Make não aceita esse tipo de
certificado no plano atual" — volta pro aviso no topo do `MAKE-SETUP.md` sobre o proxy de
fallback, ainda não construído.

## O que fazer com o que for gerado

Depois que tiver `Client ID`, `Client Secret` e o certificado `.p12`, esses três vão para
a configuração do Make — ver `docs/MAKE-SETUP.md`, seção "Credenciais necessárias". O
primeiro teste prático é criar uma cobrança de centavos no **ambiente de homologação**
(sandbox, não mexe em dinheiro real) antes de qualquer coisa em produção.
