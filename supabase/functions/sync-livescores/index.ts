import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// ESPN name → nombre en BD
const ESPN_TO_DB: Record<string, string> = {
  // Américas
  'Argentina': 'Argentina',
  'Brazil': 'Brasil',
  'Uruguay': 'Uruguay',
  'Colombia': 'Colombia',
  'Chile': 'Chile',
  'Ecuador': 'Ecuador',
  'Peru': 'Perú',
  'Bolivia': 'Bolivia',
  'Paraguay': 'Paraguay',
  'Venezuela': 'Venezuela',
  'Mexico': 'México',
  'United States': 'Estados Unidos',
  'Canada': 'Canadá',
  'Costa Rica': 'Costa Rica',
  'Panama': 'Panamá',
  'Honduras': 'Honduras',
  'Jamaica': 'Jamaica',
  'Haiti': 'Haiti',
  'Curacao': 'Curazao',
  'Cuba': 'Cuba',
  // Europa
  'Germany': 'Alemania',
  'France': 'Francia',
  'Spain': 'España',
  'Italy': 'Italia',
  'Portugal': 'Portugal',
  'Netherlands': 'Países Bajos',
  'England': 'Inglaterra',
  'Switzerland': 'Suiza',
  'Croatia': 'Croacia',
  'Denmark': 'Dinamarca',
  'Belgium': 'Bélgica',
  'Poland': 'Polonia',
  'Serbia': 'Serbia',
  'Hungary': 'Hungría',
  'Slovakia': 'Eslovaquia',
  'Austria': 'Austria',
  'Scotland': 'Escocia',
  'Norway': 'Noruega',
  'Sweden': 'Suecia',
  'Romania': 'Rumania',
  'Czechia': 'Republica Checa',
  'Czech Republic': 'Republica Checa',
  'Bosnia-Herzegovina': 'Bosnia Herzegovina',
  'Bosnia and Herzegovina': 'Bosnia Herzegovina',
  // África
  'Morocco': 'Marruecos',
  'Senegal': 'Senegal',
  'Nigeria': 'Nigeria',
  'Cameroon': 'Camerún',
  'Ghana': 'Ghana',
  'Egypt': 'Egipto',
  'Algeria': 'Argelia',
  'South Africa': 'Sudafrica',
  'Ivory Coast': 'Costa de Marfil',
  "Côte d'Ivoire": 'Costa de Marfil',
  'Cape Verde': 'Cabo Verde',
  'DR Congo': 'RD Congo',
  'Tunisia': 'Tunez',
  // Asia / Oceanía
  'Japan': 'Japón',
  'South Korea': 'Corea del Sur',
  'Australia': 'Australia',
  'Saudi Arabia': 'Arabia Saudita',
  'Iran': 'Irán',
  'Qatar': 'Qatar',
  'Jordan': 'Jordania',
  'Iraq': 'Irak',
  'Uzbekistan': 'Uzbekistan',
  'New Zealand': 'Nueva Zelanda',
  // AFA clubes
  'Boca Juniors': 'Boca Juniors',
  'River Plate': 'River Plate',
  'Racing Club': 'Racing Club',
  'Independiente': 'Independiente',
  'San Lorenzo': 'San Lorenzo',
  'Huracán': 'Huracán',
  'Huracan': 'Huracán',
  'Estudiantes': 'Estudiantes',
  'Talleres': 'Talleres',
  'Belgrano': 'Belgrano',
  'Rosario Central': 'Rosario Central',
  "Newell's Old Boys": "Newell's Old Boys",
  'Lanús': 'Lanús',
  'Lanus': 'Lanús',
  'Banfield': 'Banfield',
  'Tigre': 'Tigre',
  'Platense': 'Platense',
  'Vélez Sársfield': 'Vélez Sársfield',
  'Velez Sarsfield': 'Vélez Sársfield',
  'Defensa y Justicia': 'Defensa y Justicia',
  'Barracas Central': 'Barracas Central',
  'Aldosivi': 'Aldosivi',
  'Argentinos Juniors': 'Argentinos Juniors',
  'Atlético Tucumán': 'Atlético Tucumán',
  'Atletico Tucuman': 'Atlético Tucumán',
  'Central Córdoba': 'Central Córdoba',
  'Central Cordoba': 'Central Córdoba',
  'Gimnasia La Plata': 'Gimnasia LP',
  'Gimnasia y Esgrima La Plata': 'Gimnasia LP',
  'Independiente Rivadavia': 'Independiente Rivadavia',
  'Instituto': 'Instituto',
  'Riestra': 'Riestra',
  'Sarmiento': 'Sarmiento',
  'Unión': 'Unión',
  'Union': 'Unión',
}

const ESPN_LEAGUES: Record<string, string> = {
  mundial: 'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard',
  cwc: 'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.cwc/scoreboard',
  liga: 'https://site.api.espn.com/apis/site/v2/sports/soccer/arg.1/scoreboard',
  libertadores: 'https://site.api.espn.com/apis/site/v2/sports/soccer/conmebol.libertadores/scoreboard',
  sudamericana: 'https://site.api.espn.com/apis/site/v2/sports/soccer/conmebol.sudamericana/scoreboard',
}

function mapName(espnName: string): string | null {
  return ESPN_TO_DB[espnName] ?? null
}

function mapStatus(espnStatus: string): string {
  if (espnStatus === 'STATUS_IN_PROGRESS') return 'en_juego'
  if (espnStatus === 'STATUS_HALFTIME') return 'en_juego'
  if (espnStatus === 'STATUS_FULL_TIME' || espnStatus === 'STATUS_FINAL') return 'finalizado'
  if (espnStatus === 'STATUS_SCHEDULED') return 'pendiente'
  return 'pendiente'
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

    // Aceptar param "liga": "mundial" | "cwc" | "liga" (default: "mundial")
    let liga = 'mundial'
    try {
      const body = await req.json()
      if (body?.liga && ESPN_LEAGUES[body.liga]) liga = body.liga
    } catch {}

    const espnUrl = ESPN_LEAGUES[liga]
    const espnRes = await fetch(espnUrl)
    if (!espnRes.ok) throw new Error(`ESPN fetch failed: ${espnRes.status}`)
    const espnData = await espnRes.json()

    const events = espnData.events ?? []
    const resultados: { partido: string; actualizado: boolean; motivo?: string }[] = []

    for (const event of events) {
      const comp = event.competitions?.[0]
      if (!comp) continue

      const competitors = comp.competitors ?? []
      // ESPN: competitors[0] = home, competitors[1] = away
      const homeComp = competitors.find((c: any) => c.homeAway === 'home') ?? competitors[0]
      const awayComp = competitors.find((c: any) => c.homeAway === 'away') ?? competitors[1]

      const espnHome = homeComp?.team?.displayName
      const espnAway = awayComp?.team?.displayName
      const dbHome = mapName(espnHome)
      const dbAway = mapName(espnAway)

      const nombre = `${espnHome} vs ${espnAway}`

      if (!dbHome || !dbAway) {
        resultados.push({ partido: nombre, actualizado: false, motivo: `Sin mapeo: ${!dbHome ? espnHome : espnAway}` })
        continue
      }

      const homeScore = parseInt(homeComp?.score ?? '0', 10)
      const awayScore = parseInt(awayComp?.score ?? '0', 10)
      const espnStatusName = event.status?.type?.name ?? ''
      const estado = mapStatus(espnStatusName)
      const minuto = event.status?.displayClock ?? null

      // Buscar equipos en BD
      const { data: equipos } = await supabase
        .from('equipos')
        .select('id, nombre')
        .in('nombre', [dbHome, dbAway])

      const homeEq = equipos?.find((e: any) => e.nombre === dbHome)
      const awayEq = equipos?.find((e: any) => e.nombre === dbAway)

      if (!homeEq || !awayEq) {
        resultados.push({ partido: nombre, actualizado: false, motivo: `Equipo no encontrado en BD` })
        continue
      }

      // Buscar partido de hoy
      const hoy = new Date().toISOString().slice(0, 10)
      const { data: partidos } = await supabase
        .from('partidos')
        .select('id, estado')
        .eq('equipo_local_id', homeEq.id)
        .eq('equipo_visitante_id', awayEq.id)
        .gte('fecha', hoy + 'T00:00:00')
        .lte('fecha', hoy + 'T23:59:59')
        .limit(1)

      if (!partidos || partidos.length === 0) {
        resultados.push({ partido: nombre, actualizado: false, motivo: 'Partido no encontrado en BD para hoy' })
        continue
      }

      const partido = partidos[0]

      // No sobreescribir si ya está finalizado en BD y ESPN también dice finalizado
      const updateData: any = { goles_local: homeScore, goles_visitante: awayScore, estado }
      if (estado === 'en_juego' && minuto) updateData.minuto = minuto

      const { error } = await supabase
        .from('partidos')
        .update(updateData)
        .eq('id', partido.id)

      if (error) {
        resultados.push({ partido: nombre, actualizado: false, motivo: error.message })
      } else {
        resultados.push({ partido: nombre, actualizado: true })
      }
    }

    return new Response(JSON.stringify({ ok: true, liga, partidos_procesados: resultados }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
