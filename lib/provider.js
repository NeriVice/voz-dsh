/**
 * Proveedor de dictado por voz para DSH basado en la API de Gemini.
 *
 * El proveedor implementa el contrato `SpeechProvider` del paquete
 * `@deepseek-ai/dsh-experimental-speech-to-text`: recibe un WAV canónico
 * (16 kHz, mono, PCM 16 bits) y devuelve texto plano. No conoce la UI, el
 * portapapeles ni la sesión: solo transcribe. La UI de DSH decide dónde
 * insertar el resultado, y el usuario sigue siendo quien envía el mensaje.
 *
 * Privacidad: el audio sale de esta máquina hacia Google. No se escribe en
 * disco, no se guarda en la sesión y no se reutiliza para entrenamiento desde
 * este plugin.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { wavDurationSeconds } from './wav.js'

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta'
const DEFAULT_MODEL = 'gemini-3.5-flash-lite'
const DEFAULT_TIMEOUT_MS = 60_000
const MAX_KEY_BYTES = 4096

/** Nombres que se usan dentro del prompt para fijar el idioma del dictado. */
const LANGUAGE_NAMES = {
  es: 'español',
  en: 'inglés',
  auto: 'el idioma que se hable',
}

/** Error con un mensaje pensado para mostrarse en la barra de dictado. */
export class VoiceError extends Error {
  constructor(message) {
    super(message)
    this.name = 'VoiceError'
  }
}

function expandHome(path) {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

function readKeyFile(path) {
  try {
    const key = readFileSync(path, 'utf8').trim()
    return key.length > 0 && key.length <= MAX_KEY_BYTES ? key : undefined
  } catch {
    return undefined
  }
}

/**
 * Resuelve la clave de API en este orden: entorno, config, archivo config,
 * y las rutas convencionales de DSH. El archivo se lee en cada grabación para
 * que rotar la clave no requiera reiniciar el Host.
 *
 * @param {Record<string, unknown>} [config]
 * @param {Record<string, string | undefined>} [env]
 * @returns {string | undefined}
 */
export function resolveApiKey(config = {}, env = process.env) {
  const fromEnv = env.GEMINI_API_KEY?.trim() || env.GOOGLE_API_KEY?.trim()
  if (fromEnv) return fromEnv

  if (typeof config.apiKey === 'string' && config.apiKey.trim()) {
    return config.apiKey.trim()
  }

  const candidates = []
  if (typeof config.apiKeyFile === 'string' && config.apiKeyFile.trim()) {
    candidates.push(resolve(expandHome(config.apiKeyFile.trim())))
  }
  candidates.push(join(homedir(), '.dsh', 'voice-gemini.key'))
  candidates.push(join(homedir(), '.config', 'dsh', 'voice-gemini.key'))

  for (const path of candidates) {
    const key = readKeyFile(path)
    if (key) return key
  }
  return undefined
}

/**
 * Limpia adornos que el modelo añade ocasionalmente sin tocar el contenido.
 * No corrige ortografía ni reescribe: el dictado debe llegar editable tal cual.
 *
 * @param {string} raw
 * @returns {string}
 */
export function cleanTranscript(raw) {
  let text = String(raw ?? '').trim()
  if (text.startsWith('```') && text.endsWith('```')) {
    text = text.replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, '').trim()
  }
  text = text.replace(/^(transcripci[oó]n|transcription|texto|text)\s*:\s*/i, '').trim()
  const pairs = [
    ['"', '"'],
    ['“', '”'],
    ["'", "'"],
  ]
  for (const [open, close] of pairs) {
    if (text.length >= 2 && text.startsWith(open) && text.endsWith(close)) {
      text = text.slice(1, -1).trim()
      break
    }
  }
  return text
}

async function describeHttpFailure(response) {
  let detail = ''
  try {
    const body = await response.json()
    detail = typeof body?.error?.message === 'string' ? body.error.message : ''
  } catch {
    // Algunos errores de pasarela no traen JSON.
  }
  if (response.status === 401 || response.status === 403) {
    return 'La clave de API de Gemini no es válida o no tiene permiso para este modelo.'
  }
  if (response.status === 429) {
    return 'Gemini rechazó la solicitud por límite de uso. Espera un momento y vuelve a intentarlo.'
  }
  if (response.status === 404) {
    return `El modelo configurado no está disponible (HTTP 404).${detail ? ` ${detail}` : ''}`
  }
  if (response.status === 400) {
    return `Gemini rechazó el audio (HTTP 400).${detail ? ` ${detail}` : ''}`
  }
  return `Gemini respondió HTTP ${response.status}.${detail ? ` ${detail}` : ''}`
}

/**
 * Crea una instancia del proveedor. Se exporta aparte del plugin de Cordis para
 * poder probarla sin levantar el Host.
 *
 * @param {Record<string, any>} [config]
 * @returns {{ info: { id: string, name: string, location: 'cloud', languages: string[] }, transcribe: Function }}
 */
export function createGeminiProvider(config = {}) {
  const model = typeof config.model === 'string' && config.model.trim()
    ? config.model.trim()
    : DEFAULT_MODEL
  const apiBase = typeof config.apiBase === 'string' && config.apiBase.trim()
    ? config.apiBase.replace(/\/+$/, '')
    : API_BASE
  const timeoutMs = Number.isFinite(config.timeoutMs) && config.timeoutMs > 0
    ? config.timeoutMs
    : DEFAULT_TIMEOUT_MS
  const languages = Array.isArray(config.languages) && config.languages.length > 0
    ? config.languages.map(String)
    : ['es', 'en', 'auto']

  const info = {
    id: typeof config.providerId === 'string' && config.providerId.trim()
      ? config.providerId.trim()
      : 'gemini-voz',
    name: typeof config.providerName === 'string' && config.providerName.trim()
      ? config.providerName.trim()
      : 'Gemini (nube)',
    location: 'cloud',
    languages,
  }

  return {
    info,

    /**
     * Transcribe una grabación completa. El audio se mantiene en memoria y se
     * envía en la misma petición que produce el texto.
     *
     * @param {{ audio: Uint8Array, language: string }} input
     * @param {AbortSignal} signal
     * @returns {Promise<{ text: string, audioSeconds: number, inferenceSeconds: number }>}
     */
    async transcribe(input, signal) {
      signal?.throwIfAborted?.()
      const key = resolveApiKey(config)
      if (!key) {
        throw new VoiceError(
          'No hay clave de API de Gemini. Guárdala en ~/.dsh/voice-gemini.key o define GEMINI_API_KEY.',
        )
      }

      const audio = input.audio
      if (!(audio instanceof Uint8Array) || audio.byteLength === 0) {
        throw new VoiceError('La grabación llegó vacía.')
      }

      const started = performance.now()
      const language = input.language || 'es'
      const request = {
        contents: [
          {
            role: 'user',
            parts: [
              { text: buildPrompt(language) },
              {
                inlineData: {
                  mimeType: 'audio/wav',
                  data: Buffer.from(audio).toString('base64'),
                },
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 2048,
        },
      }

      const timeout = new AbortController()
      const timer = setTimeout(
        () => timeout.abort(new VoiceError('La transcripción tardó demasiado. Inténtalo de nuevo.')),
        timeoutMs,
      )
      const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal

      try {
        const response = await fetch(
          `${apiBase}/models/${encodeURIComponent(model)}:generateContent`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-goog-api-key': key,
            },
            body: JSON.stringify(request),
            signal: combined,
          },
        )

        if (!response.ok) throw new VoiceError(await describeHttpFailure(response))

        const payload = await response.json()
        if (payload?.promptFeedback?.blockReason) {
          throw new VoiceError(
            `Gemini bloqueó el audio (${payload.promptFeedback.blockReason}). Prueba con otra grabación.`,
          )
        }

        const candidate = payload?.candidates?.[0]
        if (!candidate) {
          throw new VoiceError('Gemini no devolvió ninguna transcripción. Inténtalo de nuevo.')
        }
        if (candidate.finishReason === 'SAFETY') {
          throw new VoiceError('Gemini bloqueó la transcripción por sus filtros de seguridad.')
        }

        const text = cleanTranscript(
          (candidate.content?.parts ?? [])
            .map((part) => (typeof part?.text === 'string' ? part.text : ''))
            .join(''),
        )

        return {
          text,
          audioSeconds: wavDurationSeconds(audio),
          inferenceSeconds: (performance.now() - started) / 1000,
        }
      } catch (error) {
        if (signal?.aborted) throw error
        if (timeout.signal.aborted) {
          throw new VoiceError('La transcripción tardó demasiado. Inténtalo de nuevo.')
        }
        if (error instanceof VoiceError) throw error
        const detail = error instanceof Error && error.message ? ` (${error.message})` : ''
        throw new VoiceError(`No se pudo contactar con Gemini${detail}.`)
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
