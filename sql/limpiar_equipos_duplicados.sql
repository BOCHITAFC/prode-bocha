-- Limpieza de equipos duplicados (creados por importar-fixture el 11 y 12/09 a las 06:00 UTC)
-- Causa: el importador descartaba el error al leer equipos y seguia con la lista vacia,
-- asi que recreaba equipos que ya existian. Corregido en importar-fixture (ahora aborta).
--
-- Solo un partido quedo apuntando a un duplicado:
--   110774  Newell's (id 394, duplicado) 1-1 Velez  ->  es el mismo partido que
--   110764  Newell's (id 19,  original)  1-1 Velez
--
-- CORRER EN DOS PASOS: primero el PASO 1 (solo lectura), revisar, despues el PASO 2.


-- ===== PASO 1: diagnostico (no modifica nada) =====

-- 1a) Quien pronostico cada uno de los dos partidos de Newell's.
--     "ambos" = sumo puntos dos veces por el mismo partido; al limpiar pierde el repetido.
select pr.alias,
       max(case when x.partido_id = 110764 then x.goles_local || '-' || x.goles_visitante || ' (' || coalesce(x.puntos, 0) || ' pts)' end) as en_original_110764,
       max(case when x.partido_id = 110774 then x.goles_local || '-' || x.goles_visitante || ' (' || coalesce(x.puntos, 0) || ' pts)' end) as en_duplicado_110774,
       case when count(distinct x.partido_id) = 2 then 'ambos'
            when max(x.partido_id) = 110774 then 'solo duplicado -> se mueve'
            else 'solo original' end as que_pasa
  from public.pronosticos x
  join public.profiles pr on pr.id = x.user_id
 where x.partido_id in (110764, 110774)
 group by pr.alias
 order by pr.alias;

-- 1b) Que tarea programada llama al importador a las 06:00 UTC
-- select jobid, jobname, schedule, active, command from cron.job order by jobid;


-- ===== PASO 2: limpieza (todo o nada) =====

begin;

-- Pronosticos que solo existen en el duplicado: pasan al partido original
update public.pronosticos d
   set partido_id = 110764
 where d.partido_id = 110774
   and not exists (
     select 1 from public.pronosticos o
      where o.partido_id = 110764 and o.user_id = d.user_id
   );

-- Borrar el partido duplicado (sus pronosticos repetidos se van por cascade)
delete from public.partidos where id = 110774;

-- Borrar los equipos duplicados, solo si ya ningun partido los usa
delete from public.equipos e
 where e.id in (348, 394, 395, 396, 397, 398, 399, 405, 406, 407, 410, 413, 417, 419, 420)
   and not exists (
     select 1 from public.partidos p
      where p.equipo_local_id = e.id
         or p.equipo_visitante_id = e.id
         or p.ganador_penales_id = e.id
   );

commit;

-- Verificacion: tiene que devolver 0 filas
-- select lower(nombre), count(*) from public.equipos group by 1 having count(*) > 1;
