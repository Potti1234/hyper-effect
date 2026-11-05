/* Uploaded files reach `update` as web `File`s, as in the browser, and the
   Commands that read them use Foldkit's `File.readAsText` / `readAsDataUrl` /
   `readAsArrayBuffer`, which are built on the browser's `FileReader`. Node
   has `File` and `Blob` but no `FileReader`; this one implements the part
   Foldkit uses on top of the `Blob` methods. It is installed only where no
   `FileReader` exists. */

type Mode = 'text' | 'dataUrl' | 'arrayBuffer'

class ServerFileReader extends EventTarget {
  static readonly EMPTY = 0
  static readonly LOADING = 1
  static readonly DONE = 2

  readyState = ServerFileReader.EMPTY
  result: string | ArrayBuffer | null = null
  error: Error | null = null
  private aborted = false

  readAsText(blob: Blob): void {
    this.read(blob, 'text')
  }

  readAsDataURL(blob: Blob): void {
    this.read(blob, 'dataUrl')
  }

  readAsArrayBuffer(blob: Blob): void {
    this.read(blob, 'arrayBuffer')
  }

  abort(): void {
    this.aborted = true
    this.readyState = ServerFileReader.DONE
  }

  private read(blob: Blob, mode: Mode): void {
    this.readyState = ServerFileReader.LOADING
    this.aborted = false
    const reading: Promise<string | ArrayBuffer> =
      mode === 'text'
        ? blob.text()
        : mode === 'arrayBuffer'
          ? blob.arrayBuffer()
          : blob
              .arrayBuffer()
              .then(
                buffer =>
                  `data:${blob.type || 'application/octet-stream'};base64,${Buffer.from(buffer).toString('base64')}`,
              )
    reading.then(
      result => {
        if (this.aborted) return
        this.result = result
        this.readyState = ServerFileReader.DONE
        this.dispatchEvent(new Event('load'))
        this.dispatchEvent(new Event('loadend'))
      },
      (cause: unknown) => {
        if (this.aborted) return
        this.error = cause instanceof Error ? cause : new Error(String(cause))
        this.readyState = ServerFileReader.DONE
        this.dispatchEvent(new Event('error'))
        this.dispatchEvent(new Event('loadend'))
      },
    )
  }
}

/** Installs the server `FileReader` where the runtime has none. */
export const installFileReader = (): void => {
  if (typeof globalThis.FileReader === 'undefined') {
    /* eslint-disable-next-line @typescript-eslint/consistent-type-assertions */
    globalThis.FileReader = ServerFileReader as unknown as typeof FileReader
  }
}
