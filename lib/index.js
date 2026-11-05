/**
 * Entrada de Cordis del plugin de dictado por voz para DSH.
 *
 * Registra dos proveedores intercambiables:
 *  - `whisper-dsv4`: Whisper local + corrección con DeepSeek V4 Flash.
 *  - `gemini-voz`: transcripción en la nube con Gemini.
 *
 * La UI oficial de voz del compositor se encarga de grabar, mostrar niveles y
 * depositar el texto en el borrador; este paquete aporta ambos motores.
 */
import { createLocalProvider } from './local.js'
import { createGeminiProvider } from './provider.js'

export const name = 'dsh-voice-gemini'

/** El servicio de voz debe existir antes de registrar los proveedores. */
export const inject = ['speechToText']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} [config]
 */
export function apply(ctx, config = {}) {
  const options = config ?? {}
  const local = createLocalProvider(options.local ?? options)
  const gemini = createGeminiProvider(options.gemini ?? options)
  ctx.effect(() => ctx.speechToText.register(local))
  ctx.effect(() => ctx.speechToText.register(gemini))
}
