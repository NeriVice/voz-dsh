/**
 * Enlaza el runtime nativo sherpa-onnx que ya instala DSH.
 *
 * El plugin no duplica los ~100 MB del runtime nativo: usa el que vive en la
 * instalación de `dsh`. Este script crea `node_modules/sherpa-onnx-node` dentro
 * del plugin apuntando a esa copia.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

let bin
try {
  bin = execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim()
} catch {
  console.error('No se encontró el comando `dsh` en PATH.')
  process.exit(1)
}

const real = realpathSync(bin)
const candidate = join(dirname(real), '..', 'node_modules', 'sherpa-onnx-node')
const target = existsSync(candidate)
  ? realpathSync(candidate)
  : join(dirname(real), '..', '..', 'node_modules', 'sherpa-onnx-node')

if (!existsSync(target)) {
  console.error(`No se encontró sherpa-onnx-node en ${target}`)
  console.error('Instala DSH con sus dependencias o ejecuta `dsh plugin add sherpa-onnx-node`.')
  process.exit(1)
}

const link = join(packageRoot, 'node_modules', 'sherpa-onnx-node')
mkdirSync(dirname(link), { recursive: true })
try {
  symlinkSync(target, link, 'dir')
  console.log(`Enlazado ${link} -> ${target}`)
} catch (error) {
  if (error.code === 'EEXIST') console.log(`Ya existe ${link}`)
  else throw error
}
