-- ============================================================
-- Máquina expendedora: monedas por acierto exacto
-- ============================================================
-- Regla: cada acierto exacto da una moneda. El saldo NO se guarda: se calcula
--   saldo = aciertos exactos - monedas gastadas
-- Los aciertos ya viven en pronosticos, así que lo único que hay que persistir
-- es cuántas monedas gastó cada uno. Guardar el saldo aparte sería un dato
-- duplicado que se desincroniza en cuanto se recalculan puntos.
--
-- Es idempotente: se puede correr las veces que haga falta.

alter table public.profiles
  add column if not exists monedas_gastadas integer not null default 0;

-- Saldo actual del jugador. Va por RPC en vez de que el cliente cuente sobre
-- pronosticos: esa tabla está bajo RLS y desde el navegador el conteo vuelve nulo.
-- Al ser security definer, la cuenta la hace el servidor y siempre da bien.
create or replace function public.saldo_monedas()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  exactos  integer;
  gastadas integer;
  pts_ex   integer;
begin
  if auth.uid() is null then
    return 0;
  end if;

  select value::integer into pts_ex from public.config where key = 'pts_exacto';

  select count(*) into exactos
    from public.pronosticos
   where user_id = auth.uid() and puntos = pts_ex;

  select coalesce(monedas_gastadas, 0) into gastadas
    from public.profiles where id = auth.uid();

  return greatest(coalesce(exactos, 0) - coalesce(gastadas, 0), 0);
end;
$$;

grant execute on function public.saldo_monedas() to authenticated;

-- Gastar una moneda. Va por RPC y no por update directo para que el cliente no
-- pueda escribir un valor arbitrario (por ejemplo, volver el contador a 0):
-- acá sólo puede incrementarlo de a uno, y siempre sobre su propia fila.
create or replace function public.gastar_moneda()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  exactos  integer;
  gastadas integer;
  pts_ex   integer;
begin
  if auth.uid() is null then
    raise exception 'Sin sesión';
  end if;

  select value::integer into pts_ex from public.config where key = 'pts_exacto';

  select count(*) into exactos
    from public.pronosticos
   where user_id = auth.uid() and puntos = pts_ex;

  select monedas_gastadas into gastadas
    from public.profiles where id = auth.uid();

  -- El servidor decide si alcanza: si el cliente pide de más, no se descuenta.
  if gastadas >= exactos then
    raise exception 'No te quedan monedas';
  end if;

  update public.profiles
     set monedas_gastadas = monedas_gastadas + 1
   where id = auth.uid();

  return exactos - (gastadas + 1);   -- saldo que queda
end;
$$;

grant execute on function public.gastar_moneda() to authenticated;

-- Devolver monedas sin usar (el botón de devolución de la máquina). Es el reverso
-- exacto de gastar: si no existiera, el crédito devuelto se vería en pantalla pero
-- se perdería al recargar, porque en la base seguiría figurando como gastado.
create or replace function public.devolver_monedas(cantidad integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  gastadas integer;
begin
  if auth.uid() is null then
    raise exception 'Sin sesión';
  end if;
  if cantidad is null or cantidad <= 0 then
    raise exception 'Cantidad inválida';
  end if;

  select monedas_gastadas into gastadas
    from public.profiles where id = auth.uid();

  -- greatest(...,0): nunca por debajo de cero, aunque el cliente pida de más
  update public.profiles
     set monedas_gastadas = greatest(monedas_gastadas - cantidad, 0)
   where id = auth.uid();

  return greatest(gastadas - cantidad, 0);
end;
$$;

grant execute on function public.devolver_monedas(integer) to authenticated;

-- Para verificar el saldo de cada jugador:
--   select p.alias,
--          (select count(*) from public.pronosticos pr
--            where pr.user_id = p.id
--              and pr.puntos = (select value::integer from public.config where key='pts_exacto')
--          ) as exactos,
--          p.monedas_gastadas,
--          (select count(*) from public.pronosticos pr
--            where pr.user_id = p.id
--              and pr.puntos = (select value::integer from public.config where key='pts_exacto')
--          ) - p.monedas_gastadas as saldo
--     from public.profiles p order by p.alias;
