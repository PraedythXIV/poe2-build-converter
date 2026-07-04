// Live PoE2 patch-version probe (clean-room implementation, zero dependencies).
//
// Protocol constants documented by poe-tool-dev/poe-patch-update (no license —
// reimplemented from facts, no code copied): connect TCP to the GGG patch server,
// send the 2-byte query 0x01 0x06, read one reply; byte[34] = CDN URL length in
// UTF-16 code units, the URL itself is UTF-16LE starting at byte 35; the patch
// version is the last non-empty path segment of that URL.
// PoE2 server verified live: patch.pathofexile2.com:13060.
//
//   node scripts/patch-version.mjs [--json]
//
// Prints the patch version + CDN URL (or a single JSON object with --json).
// Exits non-zero on any failure so orchestrators can gate on it.

import * as net from 'node:net'
import { pathToFileURL } from 'node:url'

const POE2_HOST = 'patch.pathofexile2.com'
const POE2_PORT = 13060
const QUERY = Buffer.from([0x01, 0x06])
const URL_LEN_OFFSET = 34 // byte holding the URL length (UTF-16 code units)
const URL_OFFSET = 35 // UTF-16LE string starts here

/** One-shot TCP request/response; resolves with the raw reply buffer. */
function queryPatchServer(host, port, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port })
    const chunks = []
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`patch server ${host}:${port} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    const fail = (err) => {
      clearTimeout(timer)
      reject(err)
    }

    socket.on('connect', () => socket.write(QUERY))
    socket.on('data', (data) => {
      chunks.push(data)
      const buf = Buffer.concat(chunks)
      // Complete once we have the length byte plus the full UTF-16LE string.
      if (buf.length >= URL_OFFSET && buf.length >= URL_OFFSET + buf[URL_LEN_OFFSET] * 2) {
        clearTimeout(timer)
        socket.destroy()
        resolve(buf)
      }
    })
    socket.on('error', fail)
    socket.on('close', () => {
      const buf = Buffer.concat(chunks)
      if (buf.length >= URL_OFFSET) {
        clearTimeout(timer)
        resolve(buf)
      } else fail(new Error(`socket closed early, only ${buf.length} bytes received`))
    })
  })
}

function parseReply(buf) {
  const charCount = buf[URL_LEN_OFFSET]
  const cdnUrl = buf.toString('utf16le', URL_OFFSET, URL_OFFSET + charCount * 2)
  if (!/^https?:\/\//.test(cdnUrl)) {
    throw new Error(`reply did not contain a CDN URL (got ${JSON.stringify(cdnUrl.slice(0, 40))})`)
  }
  const patch = cdnUrl.split('/').filter(Boolean).at(-1)
  if (!/^\d+(\.\d+)+$/.test(patch ?? '')) {
    throw new Error(`could not parse a patch version out of ${cdnUrl}`)
  }
  return { patch, cdnUrl }
}

/** Probe the live PoE2 patch server. Returns { patch, cdnUrl }. Throws on failure. */
export async function probePatchServer() {
  return parseReply(await queryPatchServer(POE2_HOST, POE2_PORT))
}

// ---- CLI entry (skipped when imported as a module) ----
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const info = await probePatchServer()
    if (process.argv.includes('--json')) {
      console.log(JSON.stringify(info))
    } else {
      console.log(`PoE2 patch:  ${info.patch}`)
      console.log(`CDN URL:     ${info.cdnUrl}`)
    }
  } catch (err) {
    console.error('patch-version failed:', err.message)
    process.exit(1)
  }
}
