/**
 * Proceso hijo de reconocimiento local con sherpa-onnx y Whisper.
 *
 * Se ejecuta aparte del Host para que la decodificación nativa (varios
 * segundos y varios hilos de ONNX) no bloquee DSH ni su interfaz, y para que
 * un fallo nativo no tumbe el proceso principal. El proveedor le envía
 * muestras float32 a 16 kHz por IPC y recibe texto plano.
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)

function loadSherpa() {
  const candidates = [
    () => require('sherpa-onnx-node'),
    () => require(join(dirname(process.argv[1]), '..', 'node_modules', 'sherpa-onnx-node')),
  ]
  const failures = []
  for (const load of candidates) {
    try {
      return load()
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error))
    }
  }
  throw new Error(
    `No se encontró sherpa-onnx-node. Instálalo o ejecuta el plugin desde una instalación de DSH que lo incluya. ${failures.join(' | ')}`,
  )
}

const root = process.env.VOICE_MODEL_DIR
const prefix = process.env.VOICE_MODEL_PREFIX || 'tiny'
const threads = Number(process.env.VOICE_THREADS) || 3
if (!root) {
  console.error('[voice-local] Falta VOICE_MODEL_DIR')
  process.exit(2)
}
const encoderName = `${prefix}-encoder.int8.onnx`
const decoderName = `${prefix}-decoder.int8.onnx`
const tokensName = `${prefix}-tokens.txt`

let sherpa
let recognizer
let currentLanguage

function ensureRecognizer(language) {
  if (recognizer && currentLanguage === language) return
  if (!sherpa) sherpa = loadSherpa()
  recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      whisper: {
        encoder: join(root, encoderName),
        decoder: join(root, decoderName),
        language: language === 'auto' ? '' : language,
        task: 'transcribe',
      },
      tokens: join(root, tokensName),
      numThreads: threads,
      provider: 'cpu',
      debug: 0,
    },
  })
  currentLanguage = language
}

process.on('message', (message) => {
  if (message?.type !== 'transcribe') return
  try {
    ensureRecognizer(message.language || 'es')
    const samples = message.samples instanceof Float32Array
      ? message.samples
      : new Float32Array(message.samples)
    const stream = recognizer.createStream()
    stream.acceptWaveform({ sampleRate: 16000, samples })
    recognizer.decode(stream)
    const result = recognizer.getResult(stream)
    process.send({
      id: message.id,
      text: typeof result?.text === 'string' ? result.text : '',
      lang: result?.lang,
    })
  } catch (error) {
    process.send({
      id: message.id,
      error: error instanceof Error ? error.message : String(error),
    })
  }
})

process.on('disconnect', () => process.exit(0))
