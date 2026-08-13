-- ============================================================
-- Máquina expendedora: frecuencia de la lata secreta BOCHA
-- ============================================================
-- Se guarda en la tabla config que ya existe (key/value), así no hace falta
-- tabla nueva ni políticas nuevas: config ya tiene SELECT público y escritura
-- sólo para admin (ver schema.sql).
--
-- El valor va en PORCENTAJE, como se ve en el panel de admin: '3' = 3%.
-- El juego lo divide por 100 al leerlo.
--
-- Es idempotente: se puede correr las veces que haga falta sin pisar el valor
-- que el admin haya configurado.

insert into public.config (key, value)
values ('bocha_chance', '3')
on conflict (key) do nothing;

-- Para verificar:
--   select * from public.config where key = 'bocha_chance';
