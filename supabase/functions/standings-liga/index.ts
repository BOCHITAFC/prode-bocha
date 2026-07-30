import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const URLS: Record<string, string> = {
  liga: 'https://www.promiedos.com.ar/league/liga-profesional/hc',
  libertadores: 'https://www.promiedos.com.ar/league/libertadores/bac',
  sudamericana: 'https://www.promiedos.com.ar/league/conmebol-sudamericana/dij',
}

// Mismo diccionario de alias que importar-fixture/sync-livescores
const ALIASES: Record<string, string> = {
  'central cordoba sde': 'central cordoba',
  'central cordoba santiago del estero': 'central cordoba',
  'deportivo riestra': 'riestra',
  'estudiantes de la plata': 'estudiantes',
  'estudiantes la plata': 'estudiantes',
  'estudiantes lp': 'estudiantes',
  'estudiantes de rio cuarto': 'estudiantes rc',
  'estudiantes rio cuarto': 'estudiantes rc',
  'gimnasia la plata': 'gimnasia lp',
  'gimnasia y esgrima la plata': 'gimnasia lp',
  'gimnasia de la plata': 'gimnasia lp',
  'gimnasia de mendoza': 'gimnasia mendoza',
  'gimnasia y esgrima mendoza': 'gimnasia mendoza',
  'gimnasia y esgrima de mendoza': 'gimnasia mendoza',
  'sarmiento junin': 'sarmiento',
  'sarmiento de junin': 'sarmiento',
  'talleres de cordoba': 'talleres',
  'union de santa fe': 'union',
  'union santa fe': 'union',
  'velez sarsfield': 'velez sarsfield',
  'newells old boys': 'newells old boys',
}

function norm(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()
}

function canon(name: string): string {
  const n = norm(name)
  return ALIASES[n] || n
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    let localNombre = '', visNombre = '', competicion = 'liga'
    try {
      const body = await req.json()
      localNombre = body?.local || ''
      visNombre = body?.visitante || ''
      if (body?.competicion && URLS[body.competicion]) competicion = body.competicion
    } catch {}
    if (!localNombre || !visNombre) throw new Error('Faltan nombres de equipos')
    const PAGE_URL = URLS[competicion]

    const res = await fetch(PAGE_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'es-AR,es;q=0.9',
      }
    })
    if (!res.ok) throw new Error(`Promiedos no disponible: ${res.status}`)
    const html = await res.text()
    const match = html.match(/id="__NEXT_DATA__"[^>]+>(\{[\s\S]+?\})<\/script>/)
    if (!match) throw new Error('No se encontró data en la página')

    const data = JSON.parse(match[1])
    const tablesGroups: any[] = data?.props?.pageProps?.data?.tables_groups || []

    const localTarget = canon(localNombre)
    const visTarget = canon(visNombre)

    function buscarEquipo(target: string) {
      for (const tg of tablesGroups) {
        for (const t of (tg.tables || [])) {
          const rows = t.table?.rows || []
          for (const row of rows) {
            const teamName = row.entity?.object?.name
            if (!teamName) continue
            if (canon(teamName) === target) {
              const vals: Record<string, string> = {}
              for (const v of (row.values || [])) vals[v.key] = v.value
              return {
                grupo: t.name || null,
                posicion: row.num,
                pts: vals.Points ?? null,
                j: vals.GamePlayed ?? null,
                g: vals.GamesWon ?? null,
                e: vals.GamesEven ?? null,
                p: vals.GamesLost ?? null,
                goles: vals.Goals ?? null,
                live: !!t.table?.is_live,
              }
            }
          }
        }
      }
      return null
    }

    const local = buscarEquipo(localTarget)
    const visitante = buscarEquipo(visTarget)

    return new Response(JSON.stringify({ ok: true, local, visitante }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
