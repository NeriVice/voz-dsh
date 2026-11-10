/**
 * Utilidades WAV compartidas por los proveedores de voz.
 *
 * El Remote de DSH garantiza WAV canónico de 16 kHz, mono, PCM 16 bits; estas
 * funciones solo lo interpretan y no aceptan otros formatos en silencio.
 */

/**
 * Recorre los chunks RIFF y devuelve la duración en segundos.
 *
 * @param {Uint8Array} audio
 * @returns {number}
 */
export function wavDurationSeconds(audio) {
  try {
    if (audio.byteLength < 44) return 0
    const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength)
    if (view.getUint32(0, false) !== 0x52494646) return 0 // "RIFF"
    let offset = 12
    let byteRate = 0
    while (offset + 8 <= view.byteLength) {
      const id = String.fromCharCode(
        audio[offset],
        audio[offset + 1],
        audio[offset + 2],
        audio[offset + 3],
      )
      const size = view.getUint32(offset + 4, true)
      if (id === 'fmt ' && size >= 16) byteRate = view.getUint32(offset + 16, true)
      if (id === 'data') {
        const dataBytes = Math.min(size, view.byteLength - offset - 8)
        return byteRate > 0 ? dataBytes / byteRate : 0
      }
      offset += 8 + size + (size % 2)
    }
  } catch {
    // Un encabezado raro no debe impedir el intento de transcripción.
  }
  return 0
}

/**
 * Convierte PCM 16 bits a muestras float32 en el rango [-1, 1].
 * Si el WAV llegara en estéreo, mezcla los canales a mono.
 *
 * @param {Uint8Array} audio
 * @returns {{ samples: Float32Array, sampleRate: number }}
 */
export function wavToFloat32(audio) {
  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength)
  if (audio.byteLength < 44 || view.getUint32(0, false) !== 0x52494646) {
    throw new Error('El audio no es un WAV válido.')
  }

  let offset = 12
  let channels = 0
  let sampleRate = 0
  let bits = 0
  let dataOffset = -1
  let dataSize = 0

  while (offset + 8 <= view.byteLength) {
    const id = String.fromCharCode(
      audio[offset],
      audio[offset + 1],
      audio[offset + 2],
      audio[offset + 3],
    )
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8
    if (id === 'fmt ' && size >= 16) {
      channels = view.getUint16(body + 2, true)
      sampleRate = view.getUint32(body + 4, true)
      bits = view.getUint16(body + 14, true)
    } else if (id === 'data') {
      dataOffset = body
      dataSize = Math.min(size, view.byteLength - body)
      break
    }
    offset = body + size + (size % 2)
  }

  if (dataOffset < 0 || bits !== 16 || channels < 1 || sampleRate <= 0) {
    throw new Error('El audio debe ser WAV PCM de 16 bits.')
  }

  const frames = Math.floor(dataSize / (channels * 2))
  const samples = new Float32Array(frames)
  for (let frame = 0; frame < frames; frame++) {
    let sum = 0
    for (let channel = 0; channel < channels; channel++) {
      sum += view.getInt16(dataOffset + (frame * channels + channel) * 2, true)
    }
    samples[frame] = sum / channels / 32768
  }
  return { samples, sampleRate }
}

/**
 * Normaliza el nivel de la grabación antes del reconocimiento.
 *
 * Un micrófono flojo o un navegador que aplica supresión de ruido pueden dejar
 * la señal a un nivel en el que Whisper confunde palabras. Medido con el mismo
 * audio al 8 % de nivel: la transcripción pasa de «Hello, listen a test…» a
 * «Hello, this is a test…» solo con normalizar. La ganancia se limita para no
 * amplificar el ruido de fondo de una grabación casi muda.
 *
 * @param {Float32Array} samples - PCM mono en el rango [-1, 1].
 * @param {number} [target] - pico objetivo, por debajo de 1 para no recortar.
 * @param {number} [maxGain] - ganancia máxima aplicada.
 * @returns {Float32Array} las muestras originales o una copia amplificada.
 */
export function normalizePeak(samples, target = 0.9, maxGain = 10) {
  let peak = 0
  for (const sample of samples) {
    const value = Math.abs(sample)
    if (value > peak) peak = value
  }
  // Silencio real o nivel ya suficiente: no se toca nada.
  if (!(peak > 0.001) || peak >= target) return samples
  const gain = Math.min(maxGain, target / peak)
  const out = new Float32Array(samples.length)
  for (let index = 0; index < samples.length; index += 1) {
    const value = samples[index] * gain
    out[index] = value > 1 ? 1 : value < -1 ? -1 : value
  }
  return out
}
