import http from 'node:http'

/* A minimal HTTP load balancer for multi-node experiments: forwards every
   request to one of several local upstreams, streaming bodies both ways (SSE
   included).
   - 'sticky': a browser stays on the upstream named by its `lb` cookie; a new
     browser, or one whose upstream is down, gets the next live one.
   - 'round-robin': every request goes to the next upstream.
   The Host header is passed through, so the app's origin checks see the
   balancer's address, as behind a real proxy. */

const COOKIE = 'lb'

const cookieValue = (header, name) =>
  (header ?? '')
    .split(';')
    .map(part => part.trim().split('='))
    .find(([key]) => key === name)?.[1]

export const startBalancer = ({ port, upstreams, mode }) => {
  let turn = 0
  const counts = upstreams.map(() => 0)
  // Upstreams that refused a connection lately are skipped for a while.
  const downUntil = upstreams.map(() => 0)
  const isDown = index => downUntil[index] > Date.now()
  const nextIndex = () => {
    for (let tries = 0; tries < upstreams.length; tries += 1) {
      const index = turn % upstreams.length
      turn += 1
      if (!isDown(index)) return index
    }
    return turn++ % upstreams.length
  }

  const forward = (request, response, index, attempt) => {
    const upstream = upstreams[index]
    counts[index] += 1
    const proxied = http.request(
      { host: '127.0.0.1', port: upstream, method: request.method, path: request.url, headers: request.headers },
      upstreamResponse => {
        const headers = { ...upstreamResponse.headers }
        if (mode === 'sticky' && cookieValue(request.headers.cookie, COOKIE) !== String(index)) {
          const cookies = [headers['set-cookie'] ?? []].flat()
          headers['set-cookie'] = [...cookies, `${COOKIE}=${index}; Path=/; HttpOnly; SameSite=Lax`]
        }
        response.writeHead(upstreamResponse.statusCode ?? 502, headers)
        upstreamResponse.pipe(response)
      },
    )
    proxied.on('error', () => {
      if (!response.headersSent) downUntil[index] = Date.now() + 5000
      // The upstream is down: try the next one (the request body is gone for
      // a POST that already streamed it, so only bodiless retries are safe).
      // A POST gets its connection reset rather than a 502: Datastar retries
      // a failed request, not an error status, and the retry finds a live
      // upstream.
      if (attempt + 1 < upstreams.length && !response.headersSent && request.method === 'GET') {
        forward(request, response, (index + 1) % upstreams.length, attempt + 1)
      } else {
        response.destroy()
      }
    })
    request.pipe(proxied)
  }

  const server = http.createServer((request, response) => {
    const pinned = Number(cookieValue(request.headers.cookie, COOKIE))
    const index =
      mode === 'sticky' && Number.isInteger(pinned) && pinned >= 0 && pinned < upstreams.length && !isDown(pinned)
        ? pinned
        : nextIndex()
    forward(request, response, index, 0)
  })
  server.listen(port)
  return { counts, close: () => new Promise(resolve => server.close(resolve)) }
}
