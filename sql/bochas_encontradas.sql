-- ============================================================
-- Máquina expendedora: colección de latas BOCHA
-- ============================================================
-- Cada vez que sale la lata secreta se registra una fila. Se guarda una fila por
-- hallazgo y no un simple contador para poder mostrar CUÁNDO salió cada una, y
-- porque un contador suelto se puede pisar de dos pestañas a la vez.
--
-- Es idempotente: se puede correr las veces que haga falta.

create table if not exists public.bochas (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  encontrada  timestamptz not null default now()
);

create index if not exists bochas_user_idx on public.bochas (user_id, encontrada desc);

alter table public.bochas enable row level security;

-- Cada uno ve su colección; el resto se ve en el perfil público de cada jugador,
-- así que la lectura queda abierta (no hay nada sensible: es un contador de latas).
drop policy if exists "Todos ven las bochas" on public.bochas;
create policy "Todos ven las bochas" on public.bochas
  for select using (true);

-- Nadie inserta a mano: sólo la función de abajo, que valida la sesión.
-- Sin política de insert, un cliente no puede agregarse latas por su cuenta.

-- Registra una lata BOCHA para el usuario de la sesión.
create or replace function public.registrar_bocha()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  total integer;
begin
  if auth.uid() is null then
    raise exception 'Sin sesión';
  end if;

  insert into public.bochas (user_id) values (auth.uid());

  select count(*) into total from public.bochas where user_id = auth.uid();
  return total;
end;
$$;

grant execute on function public.registrar_bocha() to authenticated;

-- Para ver la colección de todos:
--   select p.alias, count(b.id) as bochas, max(b.encontrada) as ultima
--     from public.profiles p
--     left join public.bochas b on b.user_id = p.id
--    group by p.alias order by bochas desc;
