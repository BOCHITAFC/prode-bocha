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

function norm(s: string): string {
  return s.toLowerCase()
    .replace(/[´`'']/g, "'") // unificar variantes de apóstrofe
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9' ]/g, '').replace(/\s+/g, ' ').trim()
}

// Mismo diccionario que importar-fixture, sync-livescores y standings-liga.
// Sin esto, comparar nombres tal cual falla: en las llaves Promiedos escribe
// "Estudiantes de La Plata" y en nuestra base el equipo es "Estudiantes", así que
// el cruce no se encontraba y el panel mostraba "información no disponible".
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
}

function canon(name: string): string {
  const n = norm(name)
  return ALIASES[n] || n
}

// Un participante placeholder tiene formato "Equipo A/Equipo B"
function splitParticipante(nombre: string): string[] {
  return nombre.split('/').map(s => s.trim())
}

function participanteIncluyeEquipo(participanteNombre: string, equipoCanon: string): boolean {
  return splitParticipante(participanteNombre).some(n => canon(n) === equipoCanon)
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    let competicion = '', localNombre = '', visNombre = ''
    try {
      const body = await req.json()
      competicion = body?.competicion || ''
      localNombre = body?.local || ''
      visNombre = body?.visitante || ''
    } catch {}
    if (!URLS[competicion] || !localNombre || !visNombre) throw new Error('Parámetros inválidos')

    const res = await fetch(URLS[competicion], {
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
    const brackets = data?.props?.pageProps?.data?.brackets

    if (!brackets?.stages?.length) {
      return new Response(JSON.stringify({ ok: true, hayBrackets: false }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const localTarget = canon(localNombre)
    const visTarget = canon(visNombre)
    const stages: any[] = brackets.stages

    // Encontrar el stage actual: el que tiene un grupo cuyos 2 participantes son exactamente estos 2 equipos
    let stageIdx = -1
    for (let i = 0; i < stages.length; i++) {
      const found = (stages[i].groups || []).some((g: any) => {
        const names = (g.participants || []).map((p: any) => canon(p.name))
        return names.includes(localTarget) && names.includes(visTarget)
      })
      if (found) { stageIdx = i; break }
    }

    if (stageIdx === -1) {
      return new Response(JSON.stringify({ ok: true, hayBrackets: true, encontrado: false }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const faseActual = stages[stageIdx].name
    const faseSiguiente = stages[stageIdx + 1]?.name || null

    let rival: string | null = null
    let rivalDefinido = false

    if (faseSiguiente) {
      const nextGroups = stages[stageIdx + 1].groups || []
      for (const g of nextGroups) {
        const participantes = (g.participants || []).map((p: any) => p.name)
        // Buscar el participante (posiblemente placeholder "A/B") que incluye a alguno de los 2 equipos actuales
        const idxConNuestro = participantes.findIndex((nombre: string) =>
          participanteIncluyeEquipo(nombre, localTarget) || participanteIncluyeEquipo(nombre, visTarget)
        )
        if (idxConNuestro !== -1) {
          const otroIdx = idxConNuestro === 0 ? 1 : 0
          const otroNombre = participantes[otroIdx]
          if (otroNombre) {
            const partes = splitParticipante(otroNombre)
            rival = partes.join(' o ')
            rivalDefinido = partes.length === 1
          }
          break
        }
      }
    }

    return new Response(JSON.stringify({
      ok: true, hayBrackets: true, encontrado: true,
      faseActual, faseSiguiente, rival, rivalDefinido,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
