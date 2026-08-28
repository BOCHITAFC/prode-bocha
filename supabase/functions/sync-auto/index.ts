import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Disparador programado (pg_cron cada 2 min). Decide qué competiciones necesitan
// sincronizarse y delega en sync-livescores, que es quien scrapea Promiedos.
// Si no hay nada activo corta acá: cero requests a Promiedos, cero costo.
//
// Por qué existe: la sincronización vivía solo en el navegador (setInterval en
// index.html), así que con la app cerrada no se actualizaba nada. El partido
// River - Independiente Santa Fe (26/08) quedó trabado en 'en_juego' 36hs por eso.

const HORAS_ANTES = 6          // desde el kickoff, cubre 90' + alargue + penales holgado
const MIN_DESPUES = 30         // margen para partidos por empezar
const HORAS_ZOMBI = 12         // tope para no arrastrar un 'en_juego' mal cargado para siempre

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const url = Deno.env.get('SUPABASE_URL') ?? ''
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    const supabase = createClient(url, serviceKey)

    const ahora = Date.now()
    const desde = new Date(ahora - HORAS_ANTES * 60 * 60 * 1000).toISOString()
    const hasta = new Date(ahora + MIN_DESPUES * 60 * 1000).toISOString()
    const limiteZombi = new Date(ahora - HORAS_ZOMBI * 60 * 60 * 1000).toISOString()

    // 1) Partidos con kickoff dentro de la ventana
    const { data: porHorario } = await supabase
      .from('partidos').select('competicion')
      .gte('fecha_hora', desde).lte('fecha_hora', hasta)

    // 2) Cualquier partido que quedó marcado en juego y todavía no cerró.
    //    Esto es lo que faltaba: sin esta condición, pasadas las horas de la
    //    ventana el partido nunca se volvía a consultar y quedaba colgado.
    const { data: enJuego } = await supabase
      .from('partidos').select('competicion')
      .eq('estado', 'en_juego').gte('fecha_hora', limiteZombi)

    const ligas = [...new Set([
      ...(porHorario || []).map(p => p.competicion),
      ...(enJuego || []).map(p => p.competicion),
    ])].filter(Boolean)

    if (!ligas.length) {
      return new Response(JSON.stringify({ ok: true, ligas: [], motivo: 'sin partidos activos' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const resultados: Record<string, unknown> = {}
    for (const liga of ligas) {
      try {
        const r = await fetch(`${url}/functions/v1/sync-livescores`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ liga }),
        })
        resultados[liga] = await r.json()
      } catch (e) {
        resultados[liga] = { ok: false, error: String(e) }
      }
    }

    return new Response(JSON.stringify({ ok: true, ligas, resultados }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
