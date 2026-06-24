import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const URLS: Record<string, string> = {
  liga: 'https://www.promiedos.com.ar/league/liga-profesional/hc',
  mundial: 'https://www.promiedos.com.ar/league/fifa-world-cup/fjda',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // Accept optional "competicion" param: "liga" | "mundial" (default: "liga")
    let competicion = 'liga'
    try {
      const body = await req.json()
      if (body?.competicion && URLS[body.competicion]) competicion = body.competicion
    } catch {}

    const pageUrl = URLS[competicion]

    const res = await fetch(pageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'es-AR,es;q=0.9',
      }
    })

    if (!res.ok) throw new Error(`Promiedos no disponible: ${res.status}`)

    const html = await res.text()
    const match = html.match(/id="__NEXT_DATA__"[^>]+>(\{[\s\S]+?\})<\/script>/)
    if (!match) throw new Error('No se encontró fixture en la página')

    const data = JSON.parse(match[1])
    const filters: any[] = data?.props?.pageProps?.data?.games?.filters || []

    // Extraer el código de liga de la URL (ej: "hc" de /league/liga-profesional/hc)
    const leagueCode = pageUrl.split('/').pop() || ''

    // Obtener rounds con sus keys — para el mundial todos los que tienen key, para liga el "latest"
    const filtersWithKey = filters.filter((f: any) => f.key && f.key !== 'latest')
    const roundsToFetch = competicion === 'mundial'
      ? filtersWithKey
      : filtersWithKey.slice(-1) // Última fecha disponible

    if (roundsToFetch.length === 0) throw new Error('No hay fechas disponibles en este momento')

    // Fetch fresh game data for each round via API (evita el caché del SSR)
    const rounds: Array<{ name: string; key: string; games: any[] }> = []
    for (const f of roundsToFetch) {
      const apiUrl = `https://api.promiedos.com.ar/league/games/${leagueCode}/${f.key}`
      const apiRes = await fetch(apiUrl, {
        headers: {
          'Accept': 'application/json',
          'Origin': 'https://www.promiedos.com.ar',
          'Referer': pageUrl,
        }
      })
      if (!apiRes.ok) continue
      const apiData = await apiRes.json()
      const games: any[] = apiData?.games || []
      if (games.length > 0) rounds.push({ name: f.name, key: f.key, games })
    }

    if (rounds.length === 0) throw new Error('No hay partidos disponibles en este momento')

    const { data: equipos } = await supabase.from('equipos').select('*')

    let upserted = 0, skipped = 0
    const skippedTeams: string[] = []

    for (const round of rounds) {
      const games: any[] = round.games
      const roundName: string = round.games?.[0]?.stage_round_name || round.name || 'Fecha'
      const roundNum = parseInt(roundName.replace(/\D/g, '')) || null

      for (const game of games) {
        const homeTeamName = game.teams?.[0]?.name
        const awayTeamName = game.teams?.[1]?.name
        if (!homeTeamName || !awayTeamName) continue

        const localEq = matchEquipo(homeTeamName, equipos || [])
        const visEq = matchEquipo(awayTeamName, equipos || [])

        const localEnabled = localEq?.habilitado === true
        const visEnabled = visEq?.habilitado === true
        if (!localEq || !visEq || (!localEnabled && !visEnabled)) {
          skipped++
          if (!skippedTeams.includes(`${homeTeamName} vs ${awayTeamName}`))
            skippedTeams.push(`${homeTeamName} vs ${awayTeamName}`)
          continue
        }

        let fechaHora: string | null = null
        if (game.start_time) {
          const [datePart, timePart] = game.start_time.split(' ')
          const [dd, mm, yyyy] = datePart.split('-')
          fechaHora = new Date(`${yyyy}-${mm}-${dd}T${timePart || '00:00'}:00-03:00`).toISOString()
        }

        const statusEnum = game.status?.enum
        let estado = 'pendiente'
        if (statusEnum === 2) estado = 'en_juego'
        else if (statusEnum === 3 || statusEnum === 4) estado = 'finalizado'

        const scores = game.scores
        const golesLocal = (scores && scores[0] != null) ? Number(scores[0]) : null
        const golesVis = (scores && scores[1] != null) ? Number(scores[1]) : null

        const rawMin = game.game_time
        const minuto = estado === 'en_juego' && rawMin != null && rawMin !== '' ? parseInt(String(rawMin)) || null : null

        const mapGoles = (goals: any[]) => (goals || []).map(g => ({
          nombre: g.player_sname || g.player_name,
          minuto: g.time_to_display,
        }))
        const goleadores = {
          local: mapGoles(game.teams?.[0]?.goals),
          visitante: mapGoles(game.teams?.[1]?.goals),
        }

        const { error } = await supabase.from('partidos').upsert({
          equipo_local_id: localEq.id,
          equipo_visitante_id: visEq.id,
          fecha_hora: fechaHora,
          jornada: roundNum,
          estado,
          goles_local: golesLocal,
          goles_visitante: golesVis,
          minuto: estado === 'en_juego' ? minuto : null,
          goleadores,
        }, { onConflict: 'equipo_local_id,equipo_visitante_id,jornada' })

        if (error) { console.error('upsert error:', error); skipped++ }
        else upserted++
      }
    }

    return new Response(
      JSON.stringify({ success: true, competicion, rounds: rounds.length, upserted, skipped, skippedTeams }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (err: any) {
    console.error('Edge function error:', err)
    return new Response(
      JSON.stringify({ success: false, error: err.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})

function matchEquipo(name: string, equipos: any[]): any | null {
  const norm = (s: string) =>
    s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, '').trim()
  const n = norm(name)
  let found = equipos.find(e => norm(e.nombre) === n)
  if (found) return found
  found = equipos.find(e => n.includes(norm(e.nombre)) || norm(e.nombre).includes(n))
  if (found) return found
  const words = n.split(' ').filter((w: string) => w.length > 3)
  found = equipos.find(e => words.some((w: string) => norm(e.nombre).includes(w)))
  return found || null
}
