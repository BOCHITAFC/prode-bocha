import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const BUCKET = 'escudos'

function norm(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '').trim()
}

async function listRecursive(supabase: any, prefix = ''): Promise<string[]> {
  const { data, error } = await supabase.storage.from(BUCKET).list(prefix, { limit: 1000 })
  if (error || !data) return []
  const result: string[] = []
  for (const f of data) {
    const fullPath = prefix ? `${prefix}/${f.name}` : f.name
    if (f.id) result.push(fullPath) // archivo
    else { // carpeta
      const subFiles = await listRecursive(supabase, fullPath)
      result.push(...subFiles)
    }
  }
  return result
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const supabase = createClient(supabaseUrl, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '')

    const files = await listRecursive(supabase)

    // Indexar por clave normalizada (nombre del archivo sin extensión, normalizado)
    const fileByKey: Record<string, string> = {}
    for (const path of files) {
      const filename = path.split('/').pop() || ''
      const m = filename.match(/^(.+)\.(png|jpg|jpeg|svg|webp)$/i)
      if (!m) continue
      const key = norm(m[1])
      fileByKey[key] = path
    }

    const { data: equipos } = await supabase.from('equipos').select('id, nombre, slug, escudo_url')
    if (!equipos) throw new Error('No se pudieron leer equipos')

    let actualizados = 0
    const noEncontrados: string[] = []
    const baseUrl = `${supabaseUrl}/storage/v1/object/public/${BUCKET}`

    for (const eq of equipos) {
      // intentar match por slug normalizado, después por nombre normalizado
      const slugKey = norm(eq.slug || '')
      const nombreKey = norm(eq.nombre || '')
      const path = fileByKey[slugKey] || fileByKey[nombreKey]
      if (!path) { noEncontrados.push(`${eq.nombre} (slug:${slugKey})`); continue }

      const url = `${baseUrl}/${path}`
      if (eq.escudo_url === url) continue

      const { error } = await supabase.from('equipos').update({ escudo_url: url }).eq('id', eq.id)
      if (!error) actualizados++
    }

    return new Response(JSON.stringify({
      ok: true, actualizados, totalArchivos: Object.keys(fileByKey).length, noEncontrados
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
