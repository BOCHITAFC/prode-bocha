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

// ─────────────────── PRÓXIMO RIVAL ───────────────────
// Sale de Promiedos y no de nuestra base a propósito: la base solo tiene partidos
// donde juega al menos un equipo habilitado, así que el rival siguiente de un
// equipo que no seguimos no existe ahí. Y la última fecha importada nunca puede
// tener "siguiente" por definición.

type Juego = { fecha: Date; equipos: string[] }

// Caché en memoria del contenedor. Muchas tarjetas abiertas en una misma sesión
// comparten estos datos; sin esto cada apertura golpearía la API de Promiedos.
const cacheJuegos = new Map<string, { t: number; juegos: Juego[] }>()
const TTL_MS = 10 * 60 * 1000

// Promiedos entrega "DD-MM-YYYY HH:mm" en hora de Argentina (UTC-3).
function parseFecha(s: string): Date | null {
  const m = String(s || '').match(/^(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2})/)
  if (!m) return null
  const [, d, mo, y, hh, mi] = m
  return new Date(Date.UTC(+y, +mo - 1, +d, +hh + 3, +mi))
}

async function traerJuegos(competicion: string, leagueCode: string, filters: any[]): Promise<Juego[]> {
  const hit = cacheJuegos.get(competicion)
  if (hit && Date.now() - hit.t < TTL_MS) return hit.juegos

  const pedir = async (key: string): Promise<any[]> => {
    try {
      const r = await fetch(`https://api.promiedos.com.ar/league/games/${leagueCode}/${key}`, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'es-AR,es;q=0.9' }
      })
      if (!r.ok) return []
      const j = await r.json()
      return j?.games || []
    } catch { return [] }
  }

  const actuales = await pedir('latest')
  const nombreActual = actuales[0]?.stage_round_name || ''
  const idsActuales = new Set(actuales.map((g: any) => g?.id).filter(Boolean))

  // OJO: el nombre de la fecha NO alcanza para ubicarla. La liga tiene dos torneos
  // en el mismo listado (Apertura y Clausura), con claves 72_228_3_N y 72_228_8_N,
  // así que "Fecha 5" aparece DOS veces. Buscar por nombre agarra la primera —la del
  // torneo viejo— y termina devolviendo partidos de hace seis meses.
  //
  // Se identifica por los IDs de los partidos: la fecha actual es aquella cuyo
  // contenido coincide con lo que devolvió 'latest'. Es exacto y no depende de textos.
  const candidatos = filters.filter((f: any) =>
    f?.key && f.key !== 'latest' && norm(f?.name || '') === norm(nombreActual))

  let claveActual = ''
  for (const c of candidatos) {
    const juegosC = await pedir(c.key)
    if (juegosC.some((g: any) => idsActuales.has(g?.id))) { claveActual = c.key; break }
  }

  // Las siguientes se toman del MISMO torneo: se compara el prefijo de la clave
  // (72_228_8_) y se avanza el número de fecha, en vez de correrse por el array.
  const siguientes: any[] = []
  const m = claveActual.match(/^(.*_)(\d+)$/)
  if (m) {
    const [, prefijo, nroStr] = m
    const nro = parseInt(nroStr)
    for (let i = 1; i <= 3; i++) {
      const f = filters.find((x: any) => x?.key === `${prefijo}${nro + i}`)
      if (f) siguientes.push(f)
    }
  }

  const crudos = [...actuales]
  for (const f of siguientes) crudos.push(...await pedir(f.key))

  const juegos: Juego[] = []
  for (const g of crudos) {
    const fecha = parseFecha(g?.start_time)
    const equipos = (g?.teams || []).map((t: any) => t?.name).filter(Boolean)
    if (fecha && equipos.length === 2) juegos.push({ fecha, equipos })
  }
  cacheJuegos.set(competicion, { t: Date.now(), juegos })
  return juegos
}

// Primer partido del equipo posterior a 'desde'. El filtro por fecha es además la
// guarda contra el problema de las keys: si una fecha de Promiedos devolviera
// partidos viejos de otro torneo, quedan descartados por ser anteriores.
//
// 'parActual' es el partido que se está mirando, y hay que excluirlo a mano: si
// Promiedos lo reprogramó a un horario más tarde que el que tenemos guardado,
// queda "después de sí mismo" y se devolvería como su propio próximo rival.
// Se compara por par de equipos y sólo dentro de una ventana de días, para no
// descartar un eventual revancha meses después.
const VENTANA_MISMO_PARTIDO = 5 * 24 * 60 * 60 * 1000

function proximoRival(juegos: Juego[], equipo: string, desde: Date | null, parActual: string): string | null {
  const target = canon(equipo)
  const esElMismo = (j: Juego) => {
    if (!parActual || !desde) return false
    if (j.equipos.map(canon).sort().join('|') !== parActual) return false
    return Math.abs(j.fecha.getTime() - desde.getTime()) <= VENTANA_MISMO_PARTIDO
  }
  const candidatos = juegos
    .filter(j => j.equipos.some(n => canon(n) === target))
    .filter(j => !esElMismo(j))
    .filter(j => !desde || j.fecha.getTime() > desde.getTime())
    .sort((a, b) => a.fecha.getTime() - b.fecha.getTime())
  const j = candidatos[0]
  if (!j) return null
  return j.equipos.find(n => canon(n) !== target) || null
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    let localNombre = '', visNombre = '', competicion = 'liga', desdeISO = ''
    try {
      const body = await req.json()
      localNombre = body?.local || ''
      visNombre = body?.visitante || ''
      desdeISO = body?.desde || ''
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

    // Próximos rivales. Va en un try aparte para que un problema acá no tumbe la
    // tabla de posiciones, que es lo que el panel muestra primero.
    let proximoLocal: string | null = null
    let proximoVisitante: string | null = null
    try {
      const filters: any[] = data?.props?.pageProps?.data?.games?.filters || []
      const leagueCode = PAGE_URL.split('/').pop() || ''
      const juegos = await traerJuegos(competicion, leagueCode, filters)
      const desde = desdeISO ? new Date(desdeISO) : null
      const parActual = [localTarget, visTarget].sort().join('|')
      proximoLocal = proximoRival(juegos, localNombre, desde, parActual)
      proximoVisitante = proximoRival(juegos, visNombre, desde, parActual)
    } catch { /* se devuelve la tabla igual, sin próximos */ }

    return new Response(JSON.stringify({ ok: true, local, visitante, proximoLocal, proximoVisitante }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
