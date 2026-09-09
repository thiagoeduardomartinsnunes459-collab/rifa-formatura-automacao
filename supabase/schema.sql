-- Schema da Rifa Automatizada
-- Baseado na recomendação do debate multi-agente (@architect + @data-engineer):
-- Postgres com UPDATE condicional elimina a race condition que Sheets/Airtable não resolvem.
-- Rode este arquivo inteiro no SQL Editor do Supabase (projeto novo) uma única vez.

create extension if not exists "pgcrypto";

create type numero_status as enum ('disponivel', 'reservado', 'pago');
create type reserva_status as enum ('pendente', 'paga', 'expirada', 'cancelada');

-- Estoque dos 1000 números. Fonte da verdade única.
create table numeros (
  numero smallint primary key check (numero >= 1 and numero <= 1000),
  status numero_status not null default 'disponivel',
  reserva_id uuid,
  reservado_ate timestamptz,
  updated_at timestamptz not null default now()
);

-- Histórico append-only de tentativas de compra. Nunca sobrescreve, nunca apaga.
create table reservas (
  id uuid primary key default gen_random_uuid(),
  numero smallint not null references numeros(numero),
  nome text not null,
  whatsapp text not null,
  cpf text not null, -- exigido pela Efí em devedor.cpf
  efi_txid text, -- txid devolvido pela Efí ao criar a cobrança; correlaciona o webhook (Scenario 2) com esta reserva
  status reserva_status not null default 'pendente',
  valor_centavos integer not null default 1000,
  criada_em timestamptz not null default now(),
  expira_em timestamptz not null,
  paga_em timestamptz
);

create unique index on reservas (efi_txid) where efi_txid is not null;

-- Registro de cada notificação de pagamento recebida. gateway_txid único = idempotência do webhook.
create table pagamentos (
  id uuid primary key default gen_random_uuid(),
  gateway_txid text not null unique,
  reserva_id uuid references reservas(id),
  payload jsonb not null,
  recebido_em timestamptz not null default now()
);

create index on reservas (numero);
create index on reservas (status);
create index on numeros (status);

-- Popula os 1000 números (1 a 1000), todos disponíveis.
insert into numeros (numero)
select generate_series(1, 1000);

-- Reserva atômica: só avança se o número ainda estiver livre OU se a reserva anterior
-- já tiver expirado (reservado_ate < now()). Essa condição no WHERE é o que torna o
-- timeout "auto-curativo" — não precisa de um cron separado liberando números.
create or replace function reservar_numero(
  p_numero smallint,
  p_nome text,
  p_whatsapp text,
  p_cpf text,
  p_minutos int default 15
)
returns table(reserva_id uuid, sucesso boolean, motivo text)
language plpgsql
as $$
declare
  v_reserva_id uuid;
  v_rows int;
begin
  update numeros
  set status = 'reservado',
      reservado_ate = now() + (p_minutos || ' minutes')::interval,
      updated_at = now()
  where numero = p_numero
    and (status = 'disponivel' or (status = 'reservado' and reservado_ate < now()));

  get diagnostics v_rows = row_count;

  if v_rows = 0 then
    return query select null::uuid, false, 'numero_indisponivel';
    return;
  end if;

  insert into reservas (numero, nome, whatsapp, cpf, status, expira_em)
  values (p_numero, p_nome, p_whatsapp, p_cpf, 'pendente', now() + (p_minutos || ' minutes')::interval)
  returning id into v_reserva_id;

  update numeros set reserva_id = v_reserva_id where numero = p_numero;

  return query select v_reserva_id, true, 'reservado'::text;
end;
$$;

-- Grava o txid da Efí na reserva assim que a cobrança é criada (Scenario 1, depois do
-- módulo que chama POST /v2/cob). É o que permite ao Scenario 2 (webhook) encontrar a
-- reserva certa, já que a Efí não devolve um external_reference como outros gateways.
create or replace function vincular_txid_efi(p_reserva_id uuid, p_txid text)
returns void
language sql
as $$
  update reservas set efi_txid = p_txid where id = p_reserva_id;
$$;

-- Resolve o reserva_id a partir do txid da Efí. Chamar no Scenario 2 (webhook) antes de
-- confirmar_pagamento, já que o webhook da Efí só traz txid/endToEndId, não o reserva_id.
create or replace function reserva_id_por_txid(p_txid text)
returns uuid
language sql
stable
as $$
  select id from reservas where efi_txid = p_txid;
$$;

-- Confirmação de pagamento: idempotente por gateway_txid. Chamar isso do scenario
-- do Make que recebe o webhook do gateway, depois de validar o pagamento via GET
-- na API do gateway (nunca confiar só no payload do webhook).
create or replace function confirmar_pagamento(
  p_gateway_txid text,
  p_reserva_id uuid,
  p_payload jsonb
)
returns table(sucesso boolean, motivo text, numero smallint)
language plpgsql
as $$
declare
  v_numero smallint;
  v_reserva_atual uuid;
begin
  if exists (select 1 from pagamentos where gateway_txid = p_gateway_txid) then
    return query select false, 'ja_processado'::text, null::smallint;
    return;
  end if;

  select r.numero into v_numero from reservas r where r.id = p_reserva_id;

  insert into pagamentos (gateway_txid, reserva_id, payload)
  values (p_gateway_txid, p_reserva_id, p_payload);

  update reservas set status = 'paga', paga_em = now() where id = p_reserva_id;

  -- Pagamento pode chegar atrasado (depois da cobrança expirar e o número já ter
  -- sido reservado por outra pessoa). O pagamento em si é sempre registrado acima
  -- (rastro pra estorno manual), mas só marcamos o número como vendido se ele
  -- ainda pertencer a ESTA reserva -- senão venderíamos o mesmo número duas vezes.
  select n.reserva_id into v_reserva_atual from numeros n where n.numero = v_numero;

  if v_reserva_atual is distinct from p_reserva_id then
    return query select false, 'numero_realocado_revisar_manualmente'::text, v_numero;
    return;
  end if;

  update numeros set status = 'pago', updated_at = now() where numeros.numero = v_numero;

  return query select true, 'confirmado'::text, v_numero;
end;
$$;

-- RLS: a landing page usa a chave anon (pública). Só pode LER o estoque.
-- Toda escrita (reservar_numero, confirmar_pagamento) passa pelo Make usando a
-- service_role key, que ignora RLS. Nunca exponha a service_role key no front-end.
alter table numeros enable row level security;
alter table reservas enable row level security;
alter table pagamentos enable row level security;

create policy "leitura publica do estoque" on numeros
  for select using (true);

-- reservas e pagamentos não têm policy de leitura pública: só o Make (service_role) acessa.

-- A landing page precisa saber se UMA reserva específica já foi paga (polling da tela de
-- PIX, ver app.js). Uma policy de SELECT em `reservas` exporia nome/whatsapp/cpf de quem
-- souber o UUID; em vez disso, esta função SECURITY DEFINER contorna a RLS de forma
-- controlada e devolve só o status.
create or replace function status_reserva(p_reserva_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select status::text from reservas where id = p_reserva_id;
$$;

grant execute on function status_reserva(uuid) to anon;

-- Painel administrativo (landing/admin.html): lista todos os compradores pra cliente
-- acompanhar quem comprou o quê. RLS bloqueia leitura direta de `reservas` pela chave
-- anon (exporia nome/whatsapp de todo mundo); esta função exige um token de acesso
-- guardado em `admin_tokens`, tabela sem nenhuma policy (só SECURITY DEFINER acessa).
-- O token em si NUNCA é commitado no schema -- é inserido uma vez, manualmente, direto
-- no SQL Editor do Supabase (mesma lógica do .env: segredo fica fora do git).
create table if not exists admin_tokens (
  token text primary key,
  criado_em timestamptz not null default now()
);

alter table admin_tokens enable row level security;
-- Sem policies: nem anon nem authenticated conseguem ler/escrever aqui diretamente.

create or replace function listar_reservas_admin(p_admin_token text)
returns table(
  reserva_id uuid,
  numero smallint,
  nome text,
  whatsapp text,
  status reserva_status,
  criada_em timestamptz,
  paga_em timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from admin_tokens where token = p_admin_token) then
    raise exception 'nao autorizado';
  end if;

  return query
    select r.id, r.numero, r.nome, r.whatsapp, r.status, r.criada_em, r.paga_em
    from reservas r
    order by r.criada_em desc;
end;
$$;

grant execute on function listar_reservas_admin(text) to anon;

-- Histórico de sorteios: registra cada vencedor assim que é revelado no painel, pra
-- não depender do modal ficar aberto -- hoje ele some ao clicar em "Fechar", perdendo
-- o registro de quem ganhou o quê. Serve de comprovante caso a cliente precise provar
-- o resultado depois. Mesmo padrão de acesso das outras tabelas sensíveis: RLS ligado,
-- zero policies, só as funções SECURITY DEFINER abaixo enxergam os dados.
create table if not exists sorteio_vencedores (
  id uuid primary key default gen_random_uuid(),
  premio text not null,
  numero smallint not null,
  nome text not null,
  whatsapp text,
  sorteado_em timestamptz not null default now()
);

alter table sorteio_vencedores enable row level security;
-- Sem policies: nem anon nem authenticated conseguem ler/escrever aqui diretamente.

create or replace function registrar_vencedor_sorteio(
  p_admin_token text,
  p_premio text,
  p_numero smallint,
  p_nome text,
  p_whatsapp text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from admin_tokens where token = p_admin_token) then
    raise exception 'nao autorizado';
  end if;

  insert into sorteio_vencedores (premio, numero, nome, whatsapp)
  values (p_premio, p_numero, p_nome, p_whatsapp);
end;
$$;

grant execute on function registrar_vencedor_sorteio(text, text, smallint, text, text) to anon;

create or replace function listar_vencedores_sorteio(p_admin_token text)
returns table(
  id uuid,
  premio text,
  numero smallint,
  nome text,
  whatsapp text,
  sorteado_em timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from admin_tokens where token = p_admin_token) then
    raise exception 'nao autorizado';
  end if;

  return query
    select v.id, v.premio, v.numero, v.nome, v.whatsapp, v.sorteado_em
    from sorteio_vencedores v
    order by v.sorteado_em desc;
end;
$$;

grant execute on function listar_vencedores_sorteio(text) to anon;

-- Inscrições de push notification (painel administrativo) -- permite notificar a
-- cliente no celular, mesmo com a tela bloqueada, a cada pagamento confirmado.
-- Mesmo padrão de acesso das outras tabelas sensíveis: RLS ligado, zero policies
-- públicas, só a function abaixo (gated por admin_token) grava. Quem LÊ esta tabela
-- pra disparar as notificações é a function push-notify (Vercel), usando a
-- service_role key -- nunca a chave anon, então não precisa de function de leitura aqui.
create table if not exists push_subscriptions (
  endpoint text primary key,
  p256dh text not null,
  auth text not null,
  criada_em timestamptz not null default now()
);

alter table push_subscriptions enable row level security;
-- Sem policies: nem anon nem authenticated leem/escrevem direto aqui.

create or replace function salvar_push_subscription(
  p_admin_token text,
  p_endpoint text,
  p_p256dh text,
  p_auth text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from admin_tokens where token = p_admin_token) then
    raise exception 'nao autorizado';
  end if;

  insert into push_subscriptions (endpoint, p256dh, auth)
  values (p_endpoint, p_p256dh, p_auth)
  on conflict (endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth;
end;
$$;

grant execute on function salvar_push_subscription(text, text, text, text) to anon;

-- Pedidos: agrupa vários números escolhidos na mesma compra sob UMA cobrança PIX.
-- Aditivo -- não altera reservar_numero/vincular_txid_efi/reserva_id_por_txid/
-- confirmar_pagamento/status_reserva, que continuam servindo 100% o fluxo de
-- número único exatamente como antes. `reservas.pedido_id` é nullable: compras
-- avulsas continuam com pedido_id = null.
create table if not exists pedidos (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  whatsapp text not null,
  cpf text not null,
  efi_txid text,
  status reserva_status not null default 'pendente',
  valor_centavos integer not null,
  criada_em timestamptz not null default now(),
  expira_em timestamptz not null,
  paga_em timestamptz
);

create unique index if not exists pedidos_efi_txid_idx on pedidos (efi_txid) where efi_txid is not null;

alter table pedidos enable row level security;
-- Sem policies: nem anon nem authenticated leem/escrevem direto aqui.

alter table reservas add column if not exists pedido_id uuid references pedidos(id);

-- Reserva atômica de VÁRIOS números na mesma compra. `select ... for update`
-- trava as linhas candidatas antes de decidir; se qualquer uma não estiver
-- disponível (mesma regra de auto-cura por expiração de reservar_numero), a
-- function retorna sem escrever nada -- tudo ou nada, sem reserva parcial
-- (as travas somem quando a transação implícita do RPC termina).
create or replace function reservar_pedido(
  p_numeros smallint[],
  p_nome text,
  p_whatsapp text,
  p_cpf text,
  p_minutos int default 15
)
returns table(pedido_id uuid, sucesso boolean, motivo text, numeros_indisponiveis smallint[], quantidade smallint, valor_original text)
language plpgsql
as $$
declare
  v_pedido_id uuid;
  v_indisponiveis smallint[] := '{}';
  v_numero smallint;
  v_reserva_id uuid;
  v_linha record;
begin
  -- `for update` não pode conviver com array_agg/agregação na mesma query
  -- (Postgres proíbe FOR UPDATE com funções de agregação) -- por isso o loop
  -- explícito abaixo em vez de um único select com array_agg. As travas de
  -- linha seguem valendo até o fim da transação implícita deste RPC.
  for v_linha in
    select n.numero, n.status, n.reservado_ate
    from numeros n
    where n.numero = any(p_numeros)
    for update
  loop
    if not (v_linha.status = 'disponivel' or (v_linha.status = 'reservado' and v_linha.reservado_ate < now())) then
      v_indisponiveis := array_append(v_indisponiveis, v_linha.numero);
    end if;
  end loop;

  if array_length(v_indisponiveis, 1) > 0 then
    return query select null::uuid, false, 'numeros_indisponiveis'::text, v_indisponiveis, null::smallint, null::text;
    return;
  end if;

  insert into pedidos (nome, whatsapp, cpf, status, valor_centavos, expira_em)
  values (p_nome, p_whatsapp, p_cpf, 'pendente', array_length(p_numeros, 1) * 1000, now() + (p_minutos || ' minutes')::interval)
  returning id into v_pedido_id;

  foreach v_numero in array p_numeros loop
    update numeros
    set status = 'reservado',
        reservado_ate = now() + (p_minutos || ' minutes')::interval,
        updated_at = now()
    where numero = v_numero;

    insert into reservas (numero, nome, whatsapp, cpf, status, expira_em, pedido_id)
    values (v_numero, p_nome, p_whatsapp, p_cpf, 'pendente', now() + (p_minutos || ' minutes')::interval, v_pedido_id)
    returning id into v_reserva_id;

    update numeros set reserva_id = v_reserva_id where numero = v_numero;
  end loop;

  return query select
    v_pedido_id,
    true,
    'reservado'::text,
    null::smallint[],
    array_length(p_numeros, 1)::smallint,
    to_char(array_length(p_numeros, 1) * 1000 / 100.0, 'FM999990.00');
end;
$$;

-- Grava o txid da Efí no pedido (cobrança única cobrindo todos os números).
create or replace function vincular_txid_efi_pedido(p_pedido_id uuid, p_txid text)
returns void
language sql
as $$
  update pedidos set efi_txid = p_txid where id = p_pedido_id;
$$;

-- Resolve o pedido_id a partir do txid da Efí (mesmo papel de reserva_id_por_txid).
create or replace function pedido_id_por_txid(p_txid text)
returns uuid
language sql
stable
as $$
  select id from pedidos where efi_txid = p_txid;
$$;

-- Confirmação de pagamento de um pedido inteiro: mesma idempotência e mesma
-- proteção contra número realocado de confirmar_pagamento, aplicada a cada
-- número do pedido. Retorna os números realmente confirmados.
create or replace function confirmar_pagamento_pedido(
  p_gateway_txid text,
  p_pedido_id uuid,
  p_payload jsonb
)
returns table(sucesso boolean, motivo text, numeros smallint[])
language plpgsql
as $$
declare
  v_confirmados smallint[] := '{}';
  v_reserva record;
  v_reserva_atual uuid;
begin
  if exists (select 1 from pagamentos where gateway_txid = p_gateway_txid) then
    return query select false, 'ja_processado'::text, null::smallint[];
    return;
  end if;

  insert into pagamentos (gateway_txid, reserva_id, payload)
  values (p_gateway_txid, null, p_payload);

  update pedidos set status = 'paga', paga_em = now() where id = p_pedido_id;

  for v_reserva in select r.id, r.numero from reservas r where r.pedido_id = p_pedido_id loop
    update reservas set status = 'paga', paga_em = now() where id = v_reserva.id;

    select n.reserva_id into v_reserva_atual from numeros n where n.numero = v_reserva.numero;

    if v_reserva_atual is not distinct from v_reserva.id then
      update numeros set status = 'pago', updated_at = now() where numeros.numero = v_reserva.numero;
      v_confirmados := array_append(v_confirmados, v_reserva.numero);
    end if;
  end loop;

  return query select true, 'confirmado'::text, v_confirmados;
end;
$$;

-- Status agregado do pedido pro polling da landing page (mesmo papel de
-- status_reserva -- SECURITY DEFINER contorna a RLS sem expor nome/whatsapp/cpf).
create or replace function status_pedido(p_pedido_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select status::text from pedidos where id = p_pedido_id;
$$;

grant execute on function status_pedido(uuid) to anon;

-- Registro manual de compra (painel administrativo): usado quando o pagamento
-- acontece fora do fluxo automático (PIX direto, dinheiro, etc.) e a cliente
-- registra depois. Aceita uma lista explícita de números OU uma quantidade
-- (sorteia aleatoriamente entre os disponíveis) -- nunca os dois ao mesmo tempo.
-- Mesmo padrão de acesso das outras funções administrativas: gated por admin_token.
create or replace function registrar_compra_manual(
  p_admin_token text,
  p_nome text,
  p_whatsapp text,
  p_quantidade int default null,
  p_numeros smallint[] default null,
  p_valor_centavos int default 1000
)
returns table(numero smallint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_numeros smallint[];
begin
  if not exists (select 1 from admin_tokens where token = p_admin_token) then
    raise exception 'nao autorizado';
  end if;

  if p_nome is null or btrim(p_nome) = '' then
    raise exception 'nome e obrigatorio';
  end if;

  if p_numeros is not null and array_length(p_numeros, 1) > 0 then
    if exists (
      select 1 from numeros n
      where n.numero = any(p_numeros) and n.status <> 'disponivel'
    ) then
      raise exception 'um ou mais numeros informados nao estao disponiveis';
    end if;
    v_numeros := p_numeros;
  else
    if p_quantidade is null or p_quantidade < 1 then
      raise exception 'informe p_quantidade ou p_numeros';
    end if;

    select array_agg(n.numero) into v_numeros
    from (
      select n.numero from numeros n
      where n.status = 'disponivel'
      order by random()
      limit p_quantidade
    ) n;

    if v_numeros is null or array_length(v_numeros, 1) < p_quantidade then
      raise exception 'nao ha numeros disponiveis suficientes';
    end if;
  end if;

  return query
  with inseridos as (
    insert into reservas (numero, nome, whatsapp, cpf, status, valor_centavos, expira_em, paga_em)
    select u.numero, p_nome, p_whatsapp, '00000000000', 'paga', p_valor_centavos, now(), now()
    from unnest(v_numeros) as u(numero)
    returning id, reservas.numero as numero
  )
  update numeros n
  set status = 'pago', reserva_id = i.id, updated_at = now()
  from inseridos i
  where n.numero = i.numero
  returning n.numero;
end;
$$;

grant execute on function registrar_compra_manual(text, text, text, int, smallint[], int) to anon;
