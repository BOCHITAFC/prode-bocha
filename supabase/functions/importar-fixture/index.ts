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

    // Obtener rounds con sus keys — para el mundial todos los que tienen key
    const filtersWithKey = filters.filter((f: any) => f.key && f.key !== 'latest')
    const latestFilter = filters.find((f: any) => f.key === 'latest')

    // Cada ronda se pide una sola vez (la detección del torneo actual reusa estas respuestas)
    const cacheRondas: Record<string, any[]> = {}
    async function pedirRonda(key: string): Promise<any[]> {
      if (cacheRondas[key]) return cacheRondas[key]
      const apiRes = await fetch(`https://api.promiedos.com.ar/league/games/${leagueCode}/${key}`, {
        headers: { 'Accept': 'application/json', 'Origin': 'https://www.promiedos.com.ar', 'Referer': pageUrl }
      })
      cacheRondas[key] = apiRes.ok ? ((await apiRes.json())?.games || []) : []
      return cacheRondas[key]
    }

    // Mundial: todas las rondas.
    // Resto: la ronda actual ("latest") MÁS las rondas numeradas donde todavía quedan partidos
    // pendientes. Sin esto, un partido reprogramado a otra fecha queda en una ronda que Promiedos
    // ya no marca como actual y conserva el horario viejo para siempre (pasó con Sarmiento - River,
    // movido del 7/10 al 14/10, y antes con Estudiantes RC - San Lorenzo).
    // Las copas no entran acá: sus rondas ("Cuartos de Final") no tienen número y quedan con
    // jornada nula, así que siguen trayendo solo la ronda actual, como antes.
    const roundsToFetch: any[] = competicion === 'mundial'
      ? [...filtersWithKey]
      : (latestFilter ? [latestFilter] : filtersWithKey.slice(-1))

    if (roundsToFetch.length === 0) throw new Error('No hay fechas disponibles en este momento')

    if (competicion !== 'mundial') {
      const { data: pendientes } = await supabase.from('partidos')
        .select('jornada').eq('competicion', competicion).eq('estado', 'pendiente')
      const jornadas = [...new Set((pendientes || []).map((p: any) => p.jornada).filter((j: any) => j != null))]
      // Las "Fecha N" de Promiedos se repiten entre Apertura y Clausura (keys 72_228_3_N y 72_228_8_N).
      // Agarrar la del torneo viejo traería partidos ya jugados de los mismos equipos y pisaría datos
      // buenos, así que primero identificamos a qué torneo pertenece la ronda actual, por id de partido.
      if (jornadas.length) {
        const idsActuales = new Set((await pedirRonda(roundsToFetch[0].key)).map((g: any) => g?.id).filter(Boolean))
        const numeradas = filtersWithKey.filter((f: any) => /_\d+$/.test(f.key))
        let prefijo = ''
        for (let i = numeradas.length - 1; i >= 0 && !prefijo; i--) {
          const games = await pedirRonda(numeradas[i].key)
          if (games.some((g: any) => idsActuales.has(g?.id))) prefijo = numeradas[i].key.replace(/\d+$/, '')
        }
        if (prefijo) {
          for (const j of jornadas) {
            const f = numeradas.find((x: any) => x.key === `${prefijo}${j}`)
            if (f && !roundsToFetch.some((r: any) => r.key === f.key)) roundsToFetch.push(f)
          }
        }
      }
    }

    // Fetch fresh game data for each round via API (evita el caché del SSR)
    const rounds: Array<{ name: string; key: string; games: any[] }> = []
    for (const f of roundsToFetch) {
      const games = await pedirRonda(f.key)
      if (games.length > 0) rounds.push({ name: f.name, key: f.key, games })
    }

    if (rounds.length === 0) throw new Error('No hay partidos disponibles en este momento')

    // Si la lista de equipos no se pudo leer, abortar. Antes el error se descartaba y se seguía
    // con una lista vacía: ningún equipo matcheaba y ensureEquipo los recreaba a todos como
    // duplicados (pasó el 11 y 12/09 a las 06:00 UTC — Boca, River, Racing, Vélez, etc.).
    // Orden por id: si alguna vez hay dos equipos con el mismo nombre, matchEquipo se queda
    // siempre con el original (el más viejo) y no con el duplicado.
    let { data: equipos, error: equiposError } = await supabase.from('equipos').select('*').order('id')
    if (equiposError) throw new Error(`No se pudieron leer equipos: ${equiposError.message}`)
    if (!equipos?.length) throw new Error('La lista de equipos vino vacía; se aborta para no crear duplicados')

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

      for (const game of games) {
        // Leer la fecha/ronda POR PARTIDO (no por lote) — un mismo fetch de "latest" puede mezclar
        // partidos de distintas fechas si hay reprogramados, y cada uno trae su propio stage_round_name
        const roundName: string = game.stage_round_name || round.name || 'Fecha'
        const roundNum = parseInt(roundName.replace(/\D/g, '')) || null

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

        // Buscar partido existente por (local, visitante, competicion) — SIN exigir fecha_hora exacta,
        // ya que Promiedos puede reprogramar el horario entre imports y eso generaba duplicados.
        // Un mismo par de equipos en el mismo orden local/visitante no se repite dentro de una misma
        // competición salvo llaves ida/vuelta (que ya se distinguen porque invierten local/visitante).
        const { data: existentes } = await supabase.from('partidos')
          .select('id')
          .eq('equipo_local_id', localEq.id)
          .eq('equipo_visitante_id', visEq.id)
          .eq('competicion', competicion)
          .order('fecha_hora', { ascending: false })
          .limit(1)
        const existente = existentes?.[0] || null

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

    // Post-proceso: detectar llaves ida/vuelta en eliminatorias de copas (Libertadores/Sudamericana)
    // Un par ida/vuelta = mismos 2 equipos (invertidos como local/visitante), misma competición, ambos eliminatorios
    let idaVueltaLinked = 0
    if (competicion === 'libertadores' || competicion === 'sudamericana') {
      const { data: elimPartidos } = await supabase
        .from('partidos')
        .select('id, equipo_local_id, equipo_visitante_id, fecha_hora, partido_ida_id')
        .eq('competicion', competicion)
        .eq('es_eliminatorio', true)

      const lista = elimPartidos || []
      for (const p1 of lista) {
        if (p1.partido_ida_id) continue // ya linkeado
        // Buscar el partido "espejo": mismos equipos invertidos
        const p2 = lista.find(p2 =>
          p2.id !== p1.id &&
          p2.equipo_local_id === p1.equipo_visitante_id &&
          p2.equipo_visitante_id === p1.equipo_local_id
        )
        if (!p2) continue // partido único (sin vuelta), no tocar

        // El que tiene fecha posterior es la vuelta
        const [ida, vuelta] = new Date(p1.fecha_hora) <= new Date(p2.fecha_hora) ? [p1, p2] : [p2, p1]
        if (vuelta.partido_ida_id === ida.id) continue // ya estaba bien

        const { error: linkErr } = await supabase
          .from('partidos')
          .update({ partido_ida_id: ida.id })
          .eq('id', vuelta.id)
        if (!linkErr) idaVueltaLinked++
      }
    }

    return new Response(
      JSON.stringify({ success: true, competicion, rounds: rounds.length, upserted, skipped, creados, equiposCreados, skippedTeams, idaVueltaLinked }),
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
