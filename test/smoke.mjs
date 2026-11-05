/**
 * Prueba de humo del proveedor, sin levantar el Host de DSH.
 *
 * Uso: node test/smoke.mjs [ruta.wav]
 * Si no se pasa ruta, usa test/fixtures/dictado-es.wav.
 * EXPECT permite cambiar la palabra que debe aparecer (por defecto «dictado»).
 */
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createGeminiProvider } from '../lib/provider.js'

const here = dirname(fileURLToPath(import.meta.url))
const file = resolve(process.argv[2] ?? join(here, 'fixtures', 'dictado-es.wav'))
const audio = new Uint8Array(await readFile(file))

const provider = createGeminiProvider()
console.log(`proveedor: ${provider.info.id} (${provider.info.location})`)
console.log(`idiomas: ${provider.info.languages.join(', ')}`)
console.log(`audio: ${file} (${(audio.byteLength / 1024).toFixed(1)} KiB)`)

const result = await provider.transcribe(
  { audio, language: 'es' },
  new AbortController().signal,
)

console.log(`audio: ${result.audioSeconds.toFixed(2)} s · inferencia: ${result.inferenceSeconds.toFixed(2)} s`)
console.log(`texto: ${JSON.stringify(result.text)}`)

const expected = (process.env.EXPECT ?? 'dictado').toLowerCase()
if (!result.text.toLowerCase().includes(expected)) {
  console.error(`La transcripción no contiene «${expected}».`)
  process.exitCode = 1
}
