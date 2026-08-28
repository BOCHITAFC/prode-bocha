-- Cron de sincronizacion de resultados
-- Corre sync-auto cada 2 minutos, sin depender de que haya un navegador abierto.
-- sync-auto decide solo si hay algo que sincronizar; si no hay partidos activos
-- corta enseguida y no consulta Promiedos.

-- 1) Extensiones
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 2) Guardar la service role key en Vault.
--    IMPORTANTE: reemplazar <SERVICE_ROLE_KEY> por la clave real
--    (Panel de Supabase > Project Settings > API > service_role).
--    No la pegues en el cron directamente: queda en texto plano en cron.job.
select vault.create_secret(
  '<SERVICE_ROLE_KEY>',
  'service_role_key',
  'Service role key usada por el cron de sync-livescores'
);

-- 3) Agendar el job (cada 2 minutos). pg_cron corre en UTC, pero como es
--    cada-2-minutos-siempre, el huso horario no afecta.
select cron.schedule(
  'sync-livescores-auto',
  '*/2 * * * *',
  $$
  select net.http_post(
    url := 'https://yxittbyjbdyyyicmtunm.supabase.co/functions/v1/sync-auto',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key'
      )
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $$
);


-- ===== Verificacion =====

-- Ver el job agendado
-- select jobid, jobname, schedule, active from cron.job;

-- Ver las ultimas corridas (status debe decir 'succeeded')
-- select runid, status, return_message, start_time
--   from cron.job_run_details
--  where jobname = 'sync-livescores-auto'
--  order by start_time desc limit 10;

-- Ver las respuestas HTTP que devolvio la Edge Function
-- select id, status_code, content, created
--   from net._http_response order by created desc limit 10;


-- ===== Desactivar / borrar, si hace falta =====
-- select cron.unschedule('sync-livescores-auto');
