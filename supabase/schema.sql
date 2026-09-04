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
