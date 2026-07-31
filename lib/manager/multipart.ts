import busboy from 'busboy'
import { createWriteStream } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web'
import { pipeline } from 'node:stream/promises'
import { makeTempDir, rmrf } from './fsx'

export interface UploadedFile {
  /** The client-supplied name, reduced to a basename (see note below). */
  filename: string
  tmpPath: string
}

export interface ParsedForm {
  fields: Record<string, string>
  files: Record<string, UploadedFile>
  tmpDir: string
  cleanup(): Promise<void>
}

/**
 * Streaming multipart/form-data reader.
 *
 * `request.formData()` is deliberately avoided: it materialises every part in
 * memory, and this endpoint accepts multi-GB video uploads. busboy is fed the
 * raw request stream and each file part is written straight to `tmpBase`, which
 * the caller picks so that it sits on the destination volume — the subsequent
 * `moveInto` is then a rename, not a copy.
 *
 * Note: filenames are reduced with `path.basename`, so a crafted part cannot
 * escape the package folder. Browsers never send a path here, so this is
 * invisible in practice.
 */
export async function parseMultipart(request: Request, tmpBase: string): Promise<ParsedForm> {
  const contentType = request.headers.get('content-type') ?? ''
  const body = request.body
  if (!body) throw new Error('Empty request body')

  const tmpDir = await makeTempDir(tmpBase, '.tmp-upload-')
  const fields: Record<string, string> = {}
  const files: Record<string, UploadedFile> = {}

  try {
    await new Promise<void>((resolve, reject) => {
      const bb = busboy({
        headers: { 'content-type': contentType },
        // Limits are lifted: busboy's defaults would silently truncate the
        // `meta` field at 1 MB.
        limits: {
          fieldSize: Infinity,
          fieldNameSize: Infinity,
          fields: Infinity,
          files: Infinity,
          parts: Infinity,
        },
      })

      const writes: Promise<void>[] = []
      let seq = 0

      bb.on('field', (name: string, value: string) => {
        fields[name] = value
      })

      // busboy hands one file part at a time and pauses the source until the
      // part stream is consumed, so piping synchronously here is enough.
      bb.on('file', (name: string, stream: Readable, info: { filename?: string }) => {
        const filename = path.basename(info.filename ?? '')
        const tmpPath = path.join(tmpDir, `${seq++}${path.extname(filename)}`)
        writes.push(
          pipeline(stream, createWriteStream(tmpPath)).then(() => {
            files[name] = { filename, tmpPath }
          }),
        )
      })

      bb.on('error', reject)
      bb.on('close', () => {
        Promise.all(writes).then(() => resolve(), reject)
      })

      const nodeStream = Readable.fromWeb(body as unknown as NodeWebReadableStream<Uint8Array>)
      nodeStream.on('error', reject)
      nodeStream.pipe(bb)
    })
  } catch (e) {
    await rmrf(tmpDir)
    throw e
  }

  return { fields, files, tmpDir, cleanup: () => rmrf(tmpDir) }
}

export function isMultipart(request: Request): boolean {
  return (request.headers.get('content-type') ?? '').includes('multipart/form-data')
}
