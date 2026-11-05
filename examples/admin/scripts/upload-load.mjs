/* Concurrent large uploads (phase B6): K editors upload an image to K
   products at the same moment, as the edit page does (multipart to the
   session's upload route). Measures the time until each upload is answered,
   the server's memory during the burst, and what refusing oversized uploads
   costs.

   Requires a server started with HYPER_METRICS=1.
   Usage: node scripts/upload-load.mjs --uploads 20 --megabytes 2 --rounds 3 [--url http://localhost:3200] */

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, value, index, all) => {
    if (value.startsWith('--')) pairs.push([value.slice(2), all[index + 1]])
    return pairs
  }, []),
)
const base = args.url ?? 'http://localhost:3200'
const uploads = Number(args.uploads ?? 20)
const megabytes = Number(args.megabytes ?? 2)
const rounds = Number(args.rounds ?? 3)

const sleep = millis => new Promise(resolve => setTimeout(resolve, millis))
const metrics = async () => (await fetch(`${base}/_hyper/metrics`)).json()
const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? NaN

/** A PNG signature followed by filler: the server keeps PNGs, recognised by
 *  their first bytes. `bytes` slightly under the limit. */
const image = bytes => {
  const data = new Uint8Array(bytes)
  data.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  for (let index = 8; index < bytes; index += 1) data[index] = index % 251
  return new Blob([data], { type: 'image/png' })
}

const signIn = async () => {
  const response = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base },
    body: new URLSearchParams({ name: 'ada', next: '/products' }),
    redirect: 'manual',
  })
  return (response.headers.get('set-cookie') ?? '').split(';')[0]
}

/** An edit page's session: endpoint, cookie and the upload handler. */
const openEditor = async (userCookie, productId) => {
  const response = await fetch(`${base}/products/${productId}`, { headers: { cookie: userCookie } })
  const cookie = `${(response.headers.get('set-cookie') ?? '').split(';')[0]}; ${userCookie}`
  const html = await response.text()
  const endpoint = html.match(/data-signals:_he="'([^']+)'"/)?.[1]
  const handler = html.match(/hyperUpload\?\.\(el, [^,]+, \{h: '([^']+)'\}/)?.[1]
  if (endpoint === undefined || handler === undefined) throw new Error(`edit page ${productId} not understood`)
  return { cookie, endpoint, handler }
}

const upload = async (editor, blob, sequence) => {
  const body = new FormData()
  body.set('h', editor.handler)
  body.set('q', String(sequence))
  body.set('p', '{}')
  body.append('f', blob, 'large.png')
  const startedAt = performance.now()
  const response = await fetch(`${base}${editor.endpoint}/upload`, {
    method: 'POST',
    headers: { cookie: editor.cookie, 'datastar-request': 'true', origin: base },
    body,
  })
  await response.arrayBuffer()
  return { status: response.status, millis: performance.now() - startedAt }
}

const userCookie = await signIn()
const blob = image(Math.floor(megabytes * 1024 * 1024) - 1024)
const oversized = image(4 * 1024 * 1024)
const idle = await metrics()
console.log(`uploads: ${uploads} × ${megabytes} MB at once, ${rounds} rounds; idle RSS ${(idle.rssBytes / 1048576).toFixed(0)} MB`)

const times = []
let peakRss = 0
let failures = 0
for (let round = 1; round <= rounds; round += 1) {
  const editors = await Promise.all(
    Array.from({ length: uploads }, (_, index) => openEditor(userCookie, `P${String(index + 1).padStart(4, '0')}`)),
  )
  let sampling = true
  const sampler = (async () => {
    while (sampling) {
      peakRss = Math.max(peakRss, (await metrics()).rssBytes)
      await sleep(200)
    }
  })()
  const startedAt = performance.now()
  const outcomes = await Promise.all(editors.map(editor => upload(editor, blob, 1)))
  const wall = performance.now() - startedAt
  sampling = false
  await sampler
  failures += outcomes.filter(outcome => outcome.status !== 204).length
  times.push(...outcomes.map(outcome => outcome.millis))
  console.log(`round ${round}: ${outcomes.filter(o => o.status === 204).length}/${uploads} answered 204 in ${wall.toFixed(0)} ms`)
}

// Oversized uploads are refused from their Content-Length, before reading.
const editor = await openEditor(userCookie, 'P0100')
const refusals = await Promise.all(Array.from({ length: uploads }, () => upload(editor, oversized, 2)))
const settled = await metrics()
times.sort((a, b) => a - b)
const result = {
  uploads,
  megabytes,
  rounds,
  failures,
  answerP50: +percentile(times, 0.5).toFixed(0),
  answerP95: +percentile(times, 0.95).toFixed(0),
  idleRssMb: +(idle.rssBytes / 1048576).toFixed(0),
  peakRssMb: +(peakRss / 1048576).toFixed(0),
  rssAfterMb: +(settled.rssBytes / 1048576).toFixed(0),
  oversizedRefused: refusals.filter(refusal => refusal.status === 413).length,
  oversizedP50: +percentile(refusals.map(refusal => refusal.millis).sort((a, b) => a - b), 0.5).toFixed(0),
}
console.log(
  `answered: p50 ${result.answerP50} ms, p95 ${result.answerP95} ms, ${failures} failed; RSS idle ${result.idleRssMb} MB, peak ${result.peakRssMb} MB, after ${result.rssAfterMb} MB; ` +
    `oversized: ${result.oversizedRefused}/${uploads} refused (413), p50 ${result.oversizedP50} ms`,
)
console.log(`RESULT ${JSON.stringify(result)}`)
process.exit(0)
