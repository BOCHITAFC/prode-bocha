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

function slugify(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '').slice(0, 50)
}

function esEliminatorio(roundName: string): boolean {
  if (!roundName) return false
  const n = roundName.toLowerCase().trim()
  // Grupo: "Fecha 1", "Jornada 5", "Matchday 2", "Round 3"
  if (/^(fecha|jornada|matchday|round\s*\d)/.test(n)) return false
  if (/fase\s*de\s*grupos/.test(n)) return false
  if (/group\s*stage/.test(n)) return false
  // Todo lo demás es eliminatorio (octavos, cuartos, semis, final, play-off, repechaje, etc.)
  return true
}

function isPlaceholder(nombre: string): boolean {
  if (!nombre) return true
  if (/^[0-9][A-Z](\/[A-Z])*$/.test(nombre)) return true // 1B, 3A/B/C/D/F
  if (nombre.includes('/')) return true // "Boca Juniors/O'Higgins" = ganador de eliminatoria
  const n = nombre.toLowerCase()
  if (n.startsWith('ganador') || n.startsWith('perdedor')) return true
  if (n.startsWith('winner') || n.startsWith('loser')) return true
  if (/^(grupo|group)\s+[a-z]/i.test(nombre)) return true
  return false
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

    let { data: equipos } = await supabase.from('equipos').select('*')
    equipos = equipos || []

    // Helper: crear equipo nuevo si no existe (deshabilitado por default)
    async function ensureEquipo(nombre: string): Promise<any | null> {
      let eq = matchEquipo(nombre, equipos!)
      if (eq) {
        // Si ya existe pero no tiene esta competición en su array, agregarla
        if (!eq.competiciones?.includes(competicion)) {
          const nuevasComps = Array.from(new Set([...(eq.competiciones || []), competicion]))
          await supabase.from('equipos').update({ competiciones: nuevasComps }).eq('id', eq.id)
          eq.competiciones = nuevasComps
        }
        return eq
      }
      // Crear nuevo equipo deshabilitado
      const slug = slugify(nombre)
      const { data: created, error } = await supabase.from('equipos').insert({
        nombre, slug, habilitado: false, competiciones: [competicion],
      }).select().single()
      if (error) { console.error('crear equipo error:', error); return null }
      equipos!.push(created)
      return created
    }

    let upserted = 0, skipped = 0, creados = 0
    const skippedTeams: string[] = []
    const equiposCreados: string[] = []

    for (const round of rounds) {
      const games: any[] = round.games
      const roundName: string = round.games?.[0]?.stage_round_name || round.name || 'Fecha'
      const roundNum = parseInt(roundName.replace(/\D/g, '')) || null

      for (const game of games) {
        const homeTeamName = game.teams?.[0]?.name
        const awayTeamName = game.teams?.[1]?.name
        if (!homeTeamName || !awayTeamName) continue
        if (isPlaceholder(homeTeamName) || isPlaceholder(awayTeamName)) { skipped++; continue }

        const preLocalCount = equipos.length
        const localEq = await ensureEquipo(homeTeamName)
        if (localEq && equipos.length > preLocalCount) { creados++; equiposCreados.push(homeTeamName) }
        const preVisCount = equipos.length
        const visEq = await ensureEquipo(awayTeamName)
        if (visEq && equipos.length > preVisCount) { creados++; equiposCreados.push(awayTeamName) }

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

        // Detectar eliminatorio y ganador por penales (si el partido está finalizado)
        const esElim = esEliminatorio(roundName)
        let ganadorPenalesId: number | null = null
        if (esElim && estado === 'finalizado') {
          const penScores = game.penalty_scores || game.penalties
          if (Array.isArray(penScores) && penScores[0] != null && penScores[1] != null) {
            const penLocal = Number(penScores[0])
            const penVis = Number(penScores[1])
            if (penLocal > penVis) ganadorPenalesId = localEq.id
            else if (penVis > penLocal) ganadorPenalesId = visEq.id
          }
        }

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

        // Buscar partido existente por (local, visitante, competicion, fecha_hora)
        const { data: existente } = await supabase.from('partidos')
          .select('id')
          .eq('equipo_local_id', localEq.id)
          .eq('equipo_visitante_id', visEq.id)
          .eq('competicion', competicion)
          .eq('fecha_hora', fechaHora)
          .maybeSingle()

        const payload = {
          equipo_local_id: localEq.id,
          equipo_visitante_id: visEq.id,
          fecha_hora: fechaHora,
          jornada: roundNum,
          competicion,
          estado,
          goles_local: golesLocal,
          goles_visitante: golesVis,
          minuto: estado === 'en_juego' ? minuto : null,
          goleadores,
          es_eliminatorio: esElim,
          ganador_penales_id: ganadorPenalesId,
        }

        const { error } = existente
          ? await supabase.from('partidos').update(payload).eq('id', existente.id)
          : await supabase.from('partidos').insert(payload)

        if (error) { console.error('upsert error:', error); skipped++ }
        else upserted++
      }
    }

    return new Response(
      JSON.stringify({ success: true, competicion, rounds: rounds.length, upserted, skipped, creados, equiposCreados, skippedTeams }),
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

// Promiedos → nombre canónico en BD (ambos lados normalizados a lowercase sin acentos)
const ALIASES: Record<string, string> = {
  // Liga AFA
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
  'newells old boys': "newells old boys",
}

function matchEquipo(name: string, equipos: any[]): any | null {
  const norm = (s: string) =>
    s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()
  const raw = norm(name)
  const target = ALIASES[raw] || raw
  return equipos.find(e => norm(e.nombre) === target) || null
}
