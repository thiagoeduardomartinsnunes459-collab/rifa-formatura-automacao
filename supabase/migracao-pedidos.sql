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
