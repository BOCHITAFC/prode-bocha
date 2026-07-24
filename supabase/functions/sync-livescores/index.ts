import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const URLS: Record<string, string> = {
  liga: 'https://www.promiedos.com.ar/league/liga-profesional/hc',
  mundial: 'https://www.promiedos.com.ar/league/fifa-world-cup/fjda',
  libertadores: 'https://www.promiedos.com.ar/league/libertadores/bac',
  sudamericana: 'https://www.promiedos.com.ar/league/conmebol-sudamericana/dij',
}

function norm(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()
}

function matchEquipo(name: string, equipos: any[]): any | null {
  const n = norm(name)
  return equipos.find(e => norm(e.nombre) === n) || null
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    let liga = 'mundial'
    try {
      const body = await req.json()
      if (body?.liga && URLS[body.liga]) liga = body.liga
    } catch {}

    const pageUrl = URLS[liga]
    const res = await fetch(pageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      }
    })
    if (!res.ok) throw new Error(`Promiedos no disponible: ${res.status}`)
    const html = await res.text()
    const match = html.match(/id="__NEXT_DATA__"[^>]+>(\{[\s\S]+?\})<\/script>/)
    if (!match) throw new Error('No se encontró fixture')

    const data = JSON.parse(match[1])
    const filters: any[] = data?.props?.pageProps?.data?.games?.filters || []
    const leagueCode = pageUrl.split('/').pop() || ''

    // Buscar la ronda "latest" (activa)
    const filtersWithKey = filters.filter((f: any) => f.key && f.key !== 'latest')
    const latestFilter = filters.find((f: any) => f.key === 'latest')
    if (!filtersWithKey.length && !latestFilter) throw new Error('Sin fechas disponibles')

    // Para Mundial/Cups: traer todas las rondas con partidos próximos
    // Para Liga: solo la ronda "latest" (fecha en curso), NO la última del array
    // (esa puede ser la fecha final del torneo por numeración de Promiedos)
    const roundsToFetch = liga === 'liga'
      ? (latestFilter ? [latestFilter] : filtersWithKey.slice(-1))
      : filtersWithKey

    const { data: equipos } = await supabase.from('equipos').select('id, nombre')
    if (!equipos) throw new Error('No se pudieron leer equipos')

    const resultados: { partido: string; actualizado: boolean; motivo?: string }[] = []
    let actualizados = 0

    for (const f of roundsToFetch) {
      const apiUrl = `https://api.promiedos.com.ar/league/games/${leagueCode}/${f.key}`
      const apiRes = await fetch(apiUrl, {
        headers: { 'Accept': 'application/json', 'Origin': 'https://www.promiedos.com.ar', 'Referer': pageUrl }
      })
      if (!apiRes.ok) continue
      const apiData = await apiRes.json()
      const games: any[] = apiData?.games || []

      for (const game of games) {
        const homeName = game.teams?.[0]?.name
        const awayName = game.teams?.[1]?.name
        if (!homeName || !awayName) continue
        const localEq = matchEquipo(homeName, equipos)
        const visEq = matchEquipo(awayName, equipos)
        if (!localEq || !visEq) continue

        // Solo procesar partidos que están en juego o recién finalizados (para no machacar BD con partidos viejos)
        const statusEnum = game.status?.enum
        let estado = 'pendiente'
        if (statusEnum === 2) estado = 'en_juego'
        else if (statusEnum === 3 || statusEnum === 4) estado = 'finalizado'
        if (estado === 'pendiente') continue

        const scores = game.scores
        const golesLocal = (scores && scores[0] != null) ? Number(scores[0]) : null
        const golesVis = (scores && scores[1] != null) ? Number(scores[1]) : null
        const rawMin = game.game_time
        const minuto = estado === 'en_juego' && rawMin != null && rawMin !== '' ? String(rawMin) : null

        const mapGoles = (goals: any[]) => (goals || []).map(g => ({
          nombre: g.player_sname || g.player_name,
          minuto: g.time_to_display,
        }))
        const goleadores = {
          local: mapGoles(game.teams?.[0]?.goals),
          visitante: mapGoles(game.teams?.[1]?.goals),
        }

        // Buscar partido existente
        const { data: partidos } = await supabase
          .from('partidos').select('id, es_eliminatorio')
          .eq('equipo_local_id', localEq.id)
          .eq('equipo_visitante_id', visEq.id)
          .eq('competicion', liga)
          .limit(1)

        if (!partidos || partidos.length === 0) {
          resultados.push({ partido: `${homeName} vs ${awayName}`, actualizado: false, motivo: 'partido no encontrado' })
          continue
        }

        // Detectar ganador por penales (solo si finalizado + eliminatorio + score en penales)
        let ganadorPenalesId: number | null = null
        if (estado === 'finalizado' && partidos[0].es_eliminatorio) {
          const penScores = game.penalty_scores || game.penalties
          if (Array.isArray(penScores) && penScores[0] != null && penScores[1] != null) {
            const penLocal = Number(penScores[0])
            const penVis = Number(penScores[1])
            if (penLocal > penVis) ganadorPenalesId = localEq.id
            else if (penVis > penLocal) ganadorPenalesId = visEq.id
          }
        }

        const updatePayload: any = {
          goles_local: golesLocal,
          goles_visitante: golesVis,
          estado,
          minuto,
          goleadores,
        }
        if (ganadorPenalesId != null) updatePayload.ganador_penales_id = ganadorPenalesId

        const { error } = await supabase.from('partidos').update(updatePayload).eq('id', partidos[0].id)

        if (error) {
          resultados.push({ partido: `${homeName} vs ${awayName}`, actualizado: false, motivo: error.message })
        } else {
          actualizados++
          resultados.push({ partido: `${homeName} vs ${awayName}`, actualizado: true })
        }
      }
    }

    return new Response(JSON.stringify({ ok: true, actualizados }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
