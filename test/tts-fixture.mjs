/**
 * Genera un WAV de prueba en español con la TTS de Gemini.
 *
 * Uso: node test/tts-fixture.mjs ["texto alternativo"]
 * Requiere GEMINI_API_KEY/GOOGLE_API_KEY o ~/.dsh/voice-gemini.key y ffmpeg.
 */
import { spawnSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveApiKey } from '../lib/provider.js'

const DEFAULT_TEXT =
  'Hola, esto es una prueba de dictado por voz para DeepSeek Harness. ' +
  'Necesito revisar el informe del paciente y agregar una nota al expediente. ' +
  'La reunión es el jueves a las diez de la mañana.'

const text = process.argv[2] ?? DEFAULT_TEXT
const key = resolveApiKey()
if (!key) {
  console.error('Falta la clave: define GEMINI_API_KEY o crea ~/.dsh/voice-gemini.key')
  process.exit(2)
}

const model = process.env.TTS_MODEL ?? 'gemini-3.8-flash-tts'
const response = await fetch(
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
  {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents: [{ parts: [{ text }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
        },
      },
    }),
  },
)

if (!response.ok) {
  console.error(`TTS falló con HTTP ${response.status}: ${(await response.text()).slice(0, 400)}`)
  process.exit(1)
}

const payload = await response.json()
const inline = payload?.candidates?.[0]?.content?.parts?.find((part) => part.inlineData)?.inlineData
if (!inline?.data) {
  console.error('La TTS no devolvió audio:', JSON.stringify(payload).slice(0, 600))
  process.exit(1)
}

const source = Buffer.from(inline.data, 'base64')
const converted = spawnSync(
  'ffmpeg',
  [
    '-hide_banner',
    '-loglevel', 'error',
    '-i', 'pipe:0',
    '-ar', '16000',
    '-ac', '1',
    '-c:a', 'pcm_s16le',
    '-f', 'wav',
    'pipe:1',
  ],
  { input: source, maxBuffer: 32 * 1024 * 1024 },
)
if (converted.status !== 0 || converted.stdout.length === 0) {
  console.error('ffmpeg no pudo convertir el audio:', converted.stderr?.toString().slice(0, 400))
  process.exit(1)
}

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const output = join(dir, 'dictado-es.wav')
await mkdir(dir, { recursive: true })
await writeFile(output, converted.stdout)

// Una pausa final permite que el micrófono falso de Chrome grabe la frase
// completa sin que el archivo vuelva a empezar.
const padded = join(dir, 'dictado-es-pausa.wav')
const extra = spawnSync(
  'ffmpeg',
  [
    '-hide_banner',
    '-loglevel', 'error',
    '-i', output,
    '-af', 'apad=pad_dur=3',
    '-ar', '16000',
    '-ac', '1',
    '-c:a', 'pcm_s16le',
    '-y', padded,
  ],
  { maxBuffer: 32 * 1024 * 1024 },
)
if (extra.status !== 0) {
  console.error('ffmpeg no pudo añadir la pausa:', extra.stderr?.toString().slice(0, 400))
  process.exit(1)
}

console.log(output)
console.log(padded)
