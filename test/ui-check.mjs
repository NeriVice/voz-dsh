/**
 * Verificación de la UI de dictado con Chrome sin cabeza y micrófono falso.
 *
 * Requisitos:
 *   google-chrome --headless=new --remote-debugging-port=9222 \
 *     --user-data-dir=/tmp/dsh-chrome --use-fake-ui-for-media-stream \
 *     --use-fake-device-for-media-stream \
 *     --use-file-for-fake-audio-capture=/ruta/dictado-es.wav about:blank
 *
 * Uso:
 *   DSH_TOKEN=... node test/ui-check.mjs inspect
 *   DSH_TOKEN=... node test/ui-check.mjs dictate
 *
 * `inspect` abre la GUI y vuelca el estado; `dictate` pulsa el micrófono,
 * graba el audio falso, detiene y comprueba que el texto llegue al borrador.
 */
import { writeFile } from 'node:fs/promises'

const mode = process.argv[2] ?? 'inspect'
const token = process.env.DSH_TOKEN
if (!token) {
  console.error('Falta DSH_TOKEN')
  process.exit(2)
}

const base = process.env.DSH_URL ?? 'http://127.0.0.1:3080'
const cdp = process.env.CDP_URL ?? 'http://127.0.0.1:9222'
const target = await (await fetch(`${cdp}/json/new?about:blank`, { method: 'PUT' })).json()
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true })
  ws.addEventListener('error', reject, { once: true })
})

let nextId = 0
const pending = new Map()
const events = []
ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id) {
    const entry = pending.get(message.id)
    if (entry) {
      pending.delete(message.id)
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)))
      else entry.resolve(message.result)
    }
    return
  }
  events.push(message)
})

function send(method, params = {}) {
  const id = ++nextId
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text ?? 'evaluate failed')
  }
  return result.result.value
}

async function waitFor(expression, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return true
    await sleep(250)
  }
  return false
}

await send('Page.enable')
await send('Runtime.enable')
await send('Page.navigate', { url: `${base}/?token=${encodeURIComponent(token)}` })
await sleep(3500)

const state = await evaluate(`(() => ({
  url: location.href,
  title: document.title,
  text: document.body.innerText.slice(0, 1200),
  editables: [...document.querySelectorAll('[contenteditable="true"]')].length,
  buttons: [...document.querySelectorAll('button')].map(b => ({
    label: b.getAttribute('aria-label'),
    text: (b.innerText || '').trim().slice(0, 40),
    disabled: b.disabled,
  })).filter(b => b.label || b.text),
}))()`)

console.log(JSON.stringify(state, null, 2))

if (mode === 'dictate') {
  const mic = `document.querySelector('button[aria-label="Start recording"]')`
  if (!(await waitFor(`${mic} !== null`, 10_000))) {
    console.error('No apareció el botón del micrófono (¿proveedor listo?).')
    await send('Page.captureScreenshot', { format: 'png' }).then((shot) =>
      writeFile('/tmp/dsh-ui.png', Buffer.from(shot.data, 'base64')),
    )
    process.exit(1)
  }
  await evaluate(`${mic}.click()`)
  console.log('grabando…')
  await sleep(1500)
  const recording = await evaluate(
    `document.querySelector('button[aria-label="Stop and transcribe"]') !== null`,
  )
  console.log('¿grabando?', recording)
  await sleep(Number(process.env.RECORD_MS ?? 9000))
  const stopped = await evaluate(
    `(() => { const b = document.querySelector('button[aria-label="Stop and transcribe"]'); if (!b) return false; b.click(); return true })()`,
  )
  console.log('detenido:', stopped)
  if (!stopped) {
    console.error('No se encontró el botón de detener.')
    process.exit(1)
  }
  const inserted = await waitFor(
    `document.body.innerText.includes('dictado por voz para DeepSeek Harness')`,
    30_000,
  )
  console.log('¿texto insertado?', inserted)
  await sleep(500)
  const after = await evaluate(`(() => ({
    text: document.body.innerText.slice(0, 2000),
    editableText: [...document.querySelectorAll('[contenteditable="true"]')].map(e => e.innerText).join('\\n---\\n'),
    buttons: [...document.querySelectorAll('button')].map(b => b.getAttribute('aria-label')).filter(Boolean),
  }))()`)
  console.log(JSON.stringify(after, null, 2))
  if (!inserted) process.exitCode = 1
}


if (mode === 'settings') {
  await evaluate(`document.querySelector('button[aria-label="Plugins"]')?.click()`)
  await sleep(1800)
  const listText = await evaluate(`document.body.innerText`)
  console.log('--- lista de plugins ---')
  console.log(listText.slice(0, 2500))
  const opened = await evaluate(`(() => {
    const nodes = [...document.querySelectorAll('button, a, [role="button"]')]
    const hit = nodes.find((el) => /Voice dictation|Dictado por voz/.test(el.innerText || ''))
    if (!hit) return false
    hit.click()
    return true
  })()`)
  console.log('¿abrió Dictado por voz?', opened)
  await sleep(1800)
  const detail = await evaluate(`document.body.innerText`)
  console.log('--- detalle ---')
  console.log(detail.slice(0, 3000))
  const selects = await evaluate(`[...document.querySelectorAll('select')].map(s => ({
    value: s.value,
    options: [...s.options].map(o => ({ value: o.value, text: o.text })),
  }))`)
  console.log('selects:', JSON.stringify(selects, null, 2))
  const switches = await evaluate(`[...document.querySelectorAll('[role="switch"], input[type="checkbox"]')].map(el => ({
    tag: el.tagName,
    role: el.getAttribute('role'),
    checked: el.getAttribute('aria-checked') ?? el.checked,
    label: el.getAttribute('aria-label'),
    html: el.outerHTML.slice(0, 240),
  }))`)
  console.log('switches:', JSON.stringify(switches, null, 2))
  await send('Page.captureScreenshot', { format: 'png' }).then((s) =>
    writeFile('/tmp/dsh-settings.png', Buffer.from(s.data, 'base64')),
  )
  console.log('captura: /tmp/dsh-settings.png')
}


const shot = await send('Page.captureScreenshot', { format: 'png' })
await writeFile(process.env.SHOT ?? '/tmp/dsh-ui.png', Buffer.from(shot.data, 'base64'))
console.log('captura:', process.env.SHOT ?? '/tmp/dsh-ui.png')
ws.close()
