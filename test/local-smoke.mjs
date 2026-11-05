/**
 * Prueba del proveedor local sin levantar DSH.
 *
 * Uso: node test/local-smoke.mjs [ruta.wav]
 * Requiere el modelo en ~/.dsh/speech-to-text/whisper-tiny (o DATA_ROOT).
 * NO_CLEANUP=1 desactiva la corrección con DeepSeek para medir solo Whisper.
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLocalProvider } from '../lib/local.js'

const here = dirname(fileURLToPath(import.meta.url))
const file = resolve(process.argv[2] ?? join(here, 'fixtures', 'dictado-es-pausa.wav'))
const dataRoot = process.env.DATA_ROOT ?? join(homedir(), '.dsh', 'speech-to-text', 'whisper-tiny')
const provider = createLocalProvider({
  dataRoot,
  threads: 4,
  cleanup: process.env.NO_CLEANUP !== '1',
})

console.log(`proveedor: ${provider.info.id} (${provider.info.location})`)
console.log(`modelo: ${dataRoot}`)
console.log(`preparación: ${JSON.stringify(provider.preparation.snapshot())}`)

const audio = new Uint8Array(await readFile(file))
console.log(`audio: ${(audio.byteLength / 1024).toFixed(1)} KiB`)
try {
  const result = await provider.transcribe({ audio, language: 'es' }, new AbortController().signal)
  console.log(`audio: ${result.audioSeconds.toFixed(2)} s · total: ${result.inferenceSeconds.toFixed(2)} s`)
  console.log(`texto: ${JSON.stringify(result.text)}`)
  if (!result.text) process.exitCode = 1
} catch (error) {
  console.error('ERROR:', error)
  process.exitCode = 1
}
