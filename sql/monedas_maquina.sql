-- ============================================================
-- Máquina expendedora: monedas por aciertos
-- ============================================================
-- Reglas:
--   · cada acierto EXACTO           = 1 moneda
--   · cada 3 aciertos NO exactos    = 1 moneda  (la división trunca: 5 aciertos
--                                                dan 1 moneda, no 1,67)
--
-- El saldo NO se guarda: se calcula como ganadas - gastadas. Los aciertos ya
-- viven en pronosticos, así que lo único que hay que persistir es cuánto gastó
-- cada uno. Guardar el saldo aparte sería un dato duplicado que se desincroniza
-- en cuanto se recalculan puntos (por ejemplo al corregir un resultado).
--
-- Es idempotente: se puede correr las veces que haga falta.

alter table public.profiles
  add column if not exists monedas_gastadas integer not null default 0;

-- Monedas GANADAS por un jugador. La fórmula vive acá y en un solo lugar: si
-- estuviera repetida en cada función, cambiar la regla en una y olvidarse de la
-- otra dejaría el saldo y el control de gasto discrepando entre sí.
-- 'acierto' = pronóstico que sumó puntos, igual criterio que la columna
-- aciertos_total de la vista tabla_posiciones.
create or replace function public.monedas_ganadas(p_user uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  exactos  integer;
  aciertos integer;
  pts_ex   integer;
begin
  select value::integer into pts_ex from public.config where key = 'pts_exacto';

  select count(*) filter (where puntos = pts_ex),
         count(*) filter (where puntos > 0)
    into exactos, aciertos
    from public.pronosticos
   where user_id = p_user;

  exactos  := coalesce(exactos, 0);
  aciertos := coalesce(aciertos, 0);

  -- greatest(...,0): si alguien dejara pts_exacto en 0, los "exactos" no serían
  -- un subconjunto de los aciertos y la resta daría negativa, restando monedas.
  return exactos + (greatest(aciertos - exactos, 0) / 3);   -- división entera: trunca
end;
$$;

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
  gastadas integer;
begin
  if auth.uid() is null then
    return 0;
  end if;

  select coalesce(monedas_gastadas, 0) into gastadas
    from public.profiles where id = auth.uid();

  return greatest(public.monedas_ganadas(auth.uid()) - coalesce(gastadas, 0), 0);
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
  ganadas  integer;
  gastadas integer;
begin
  if auth.uid() is null then
    raise exception 'Sin sesión';
  end if;

  ganadas := public.monedas_ganadas(auth.uid());

  select coalesce(monedas_gastadas, 0) into gastadas
    from public.profiles where id = auth.uid();

  -- El servidor decide si alcanza: si el cliente pide de más, no se descuenta.
  if gastadas >= ganadas then
    raise exception 'No te quedan monedas';
  end if;

  update public.profiles
     set monedas_gastadas = monedas_gastadas + 1
   where id = auth.uid();

  return ganadas - (gastadas + 1);   -- saldo que queda
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

-- Verificación: contrasta la cuenta propia contra la vista tabla_posiciones.
-- Las columnas 'exactos' y 'aciertos' tienen que dar igual que las de la tabla en
-- pantalla; si no, cambió el criterio de aciertos_total y hay que revisar
-- monedas_ganadas().
--
--   select t.alias,
--          t.aciertos_exactos                       as exactos,
--          t.aciertos_total                         as aciertos,
--          t.aciertos_total - t.aciertos_exactos    as no_exactos,
--          public.monedas_ganadas(t.id)             as ganadas,
--          p.monedas_gastadas                       as gastadas,
--          public.monedas_ganadas(t.id) - p.monedas_gastadas as saldo
--     from public.tabla_posiciones t
--     join public.profiles p on p.id = t.id
--    order by saldo desc;
