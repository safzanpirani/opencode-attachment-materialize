import type { Plugin } from "@opencode-ai/plugin"
import { randomUUID } from "node:crypto"
import { lstat, mkdir, realpath, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path"

const MAX_FILE_BYTES = 25 * 1024 * 1024
const MAX_NAME_BYTES = 180
const MAX_EXTENSION_BYTES = 24
const MAX_COLLISION_ATTEMPTS = 1_000
const MAX_RANDOM_ATTEMPTS = 8

const controls = [
  [0x00, 0x1f],
  [0x7f, 0x9f],
  [0x061c, 0x061c],
  [0x200e, 0x200f],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
] satisfies ReadonlyArray<readonly [number, number]>

const safeCharacter = (char: string) => {
  const code = char.codePointAt(0) ?? 0
  return !controls.some(([start, end]) => code >= start && code <= end)
}

const takeBytes = (input: string, maximum: number) => {
  const state = { value: "", bytes: 0 }
  for (const char of input) {
    const bytes = Buffer.byteLength(char)
    if (state.bytes + bytes > maximum) break
    state.value += char
    state.bytes += bytes
  }
  return state.value
}

const displayName = (input: string | undefined) => {
  const cleaned = Array.from((input ?? "").normalize("NFC")).filter(safeCharacter).join("")
  return takeBytes(cleaned, MAX_NAME_BYTES) || "unnamed file"
}

const deviceName = (name: string) => {
  const stem = (name.split(".", 1)[0] ?? "").replace(/[. ]+$/g, "")
  return /^(con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])$/i.test(stem)
}

const safeName = (input: string | undefined, partID: string) => {
  if (input?.includes("\0")) throw new Error("filename contains a NUL byte")
  const cleaned = Array.from((input ?? "").normalize("NFC").split(/[\\/]/).at(-1) ?? "")
    .filter(safeCharacter)
    .join("")
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/[. ]+$/g, "")
  const generated = `attachment-${partID.replace(/[^0-9A-Za-z_-]/g, "").slice(-24) || randomUUID().slice(0, 8)}`
  const usable = cleaned === "" || cleaned === "." || cleaned === ".." ? generated : cleaned
  const extension = takeBytes(extname(usable), MAX_EXTENSION_BYTES)
  const stem = extension ? usable.slice(0, -extname(usable).length) : usable
  const prefixed = deviceName(usable) ? `_${stem}` : stem
  return `${takeBytes(prefixed, MAX_NAME_BYTES - Buffer.byteLength(extension))}${extension}`
}

const suffixedName = (name: string, count: number) => {
  if (count === 1) return name
  const extension = extname(name)
  const suffix = `-${count}`
  const stem = extension ? name.slice(0, -extension.length) : name
  return `${takeBytes(stem, MAX_NAME_BYTES - Buffer.byteLength(extension) - Buffer.byteLength(suffix))}${suffix}${extension}`
}

const randomlySuffixedName = (name: string) => {
  const extension = extname(name)
  const suffix = `-${randomUUID().slice(0, 8)}`
  const stem = extension ? name.slice(0, -extension.length) : name
  return `${takeBytes(stem, MAX_NAME_BYTES - Buffer.byteLength(extension) - Buffer.byteLength(suffix))}${suffix}${extension}`
}

const attachmentRoot = () => {
  if (process.env.OPENCODE_ATTACHMENT_DIR) return resolve(process.env.OPENCODE_ATTACHMENT_DIR)
  const data = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
  return resolve(data, "opencode", "v1-attachments")
}

const base64Value = (code: number) => {
  if (code >= 0x41 && code <= 0x5a) return code - 0x41
  if (code >= 0x61 && code <= 0x7a) return code - 0x61 + 26
  if (code >= 0x30 && code <= 0x39) return code - 0x30 + 52
  if (code === 0x2b || code === 0x2d) return 62
  if (code === 0x2f || code === 0x5f) return 63
  return undefined
}

const base64Whitespace = (code: number) => code === 0x20 || (code >= 0x09 && code <= 0x0d)

const inspectBase64 = (payload: string) => {
  let symbols = 0
  let padding = 0
  let lastValue = 0
  let sawPadding = false

  for (let index = 0; index < payload.length; index++) {
    const code = payload.charCodeAt(index)
    if (base64Whitespace(code)) continue
    if (code === 0x3d) {
      sawPadding = true
      padding++
      if (padding > 2) throw new Error("attachment has invalid base64 padding")
      continue
    }
    const value = base64Value(code)
    if (value === undefined || sawPadding) throw new Error("attachment has invalid base64 data")
    symbols++
    lastValue = value
  }

  const remainder = symbols % 4
  if (remainder === 1 || (padding === 1 && remainder !== 3) || (padding === 2 && remainder !== 2)) {
    throw new Error("attachment has invalid base64 length")
  }
  if (padding > 0 && (symbols + padding) % 4 !== 0) throw new Error("attachment has invalid base64 padding")
  if ((remainder === 2 && (lastValue & 0x0f) !== 0) || (remainder === 3 && (lastValue & 0x03) !== 0)) {
    throw new Error("attachment has non-canonical base64 padding bits")
  }

  return Math.floor((symbols * 6) / 8)
}

const decode = (url: string) => {
  const comma = url.indexOf(",")
  if (comma < 5 || !/(?:^|;)base64$/i.test(url.slice(5, comma))) {
    throw new Error("attachment is not a base64 data URL")
  }
  const payload = url.slice(comma + 1)
  const size = inspectBase64(payload)
  if (size > MAX_FILE_BYTES) return { status: "oversize" as const, size }
  const normalized = payload.replace(/[\t-\r ]/g, "").replaceAll("-", "+").replaceAll("_", "/")
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4)
  const bytes = Buffer.from(padded, "base64")
  if (bytes.byteLength !== size) throw new Error("attachment base64 length is invalid")
  return { status: "decoded" as const, bytes }
}

const existingInfo = (file: string) =>
  lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })

const directChild = (parent: string, candidate: string) => {
  const root = resolve(parent)
  const child = resolve(candidate)
  const relation = relative(root, child)
  if (!relation || relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation) || relation.includes(sep)) {
    throw new Error("attachment path escapes its parent directory")
  }
  return child
}

const verifyFile = async (file: string, realDirectory: string) => {
  const actual = await realpath(file)
  if (dirname(actual) !== realDirectory) throw new Error("attachment path escaped its session directory")
}

const writeExclusive = async (file: string, bytes: Buffer) =>
  writeFile(file, bytes, { flag: "wx", mode: 0o600 })
    .then(() => true)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST") return false
      throw error
    })

const save = async (
  root: string,
  session: string,
  name: string,
  bytes: Buffer,
  claimed: Set<string>,
  active: Set<string>,
) => {
  const directory = directChild(root, join(root, session))
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const directoryInfo = await lstat(directory)
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
    throw new Error("attachment session path is not a real directory")
  }
  const realRoot = await realpath(root)
  const realDirectory = await realpath(directory)
  if (realDirectory !== directChild(realRoot, join(realRoot, session))) {
    throw new Error("attachment session directory escaped its root")
  }

  const attempt = async (candidate: string, allowReuse: boolean) => {
    const file = directChild(directory, join(directory, candidate))
    if (claimed.has(file) || active.has(file)) return undefined
    active.add(file)
    try {
      const info = await existingInfo(file)
      if (allowReuse && info?.isFile() && !info.isSymbolicLink() && info.size === bytes.byteLength) {
        await verifyFile(file, realDirectory)
        claimed.add(file)
        return file
      }
      if (info) return undefined
      // TODO(review): Portable Node/Bun APIs cannot prevent a same-UID attacker from swapping the session directory between verification and this write without openat-style primitives.
      if (await writeExclusive(file, bytes)) {
        await verifyFile(file, realDirectory)
        claimed.add(file)
        return file
      }
      const raced = await existingInfo(file)
      if (allowReuse && raced?.isFile() && !raced.isSymbolicLink() && raced.size === bytes.byteLength) {
        await verifyFile(file, realDirectory)
        claimed.add(file)
        return file
      }
      return undefined
    } finally {
      active.delete(file)
    }
  }

  for (let count = 1; count <= MAX_COLLISION_ATTEMPTS; count++) {
    const file = await attempt(suffixedName(name, count), true)
    if (file) return file
  }
  for (let count = 0; count < MAX_RANDOM_ATTEMPTS; count++) {
    const file = await attempt(randomlySuffixedName(name), false)
    if (file) return file
  }
  throw new Error("attachment has too many filename collisions")
}

export const AttachmentMaterialize: Plugin = async () => {
  const active = new Set<string>()
  return {
    "chat.message": async (input, output) => {
      const claimed = new Set<string>()
      const appendText = (text: string) =>
        output.parts.push({
          id: `prt_${randomUUID().replaceAll("-", "")}`,
          sessionID: output.message.sessionID,
          messageID: output.message.id,
          type: "text",
          synthetic: true,
          text,
        })
      for (const part of output.parts.slice()) {
        if (part.type !== "file" || !part.url.startsWith("data:")) continue
        const label = displayName(part.filename)
        await Promise.resolve()
          .then(async () => {
            const content = decode(part.url)
            if (content.status === "oversize") {
              appendText(`Attachment not materialized: ${label} is ${content.size} bytes and exceeds the 25 MiB limit.`)
              return
            }
            const session = encodeURIComponent(input.sessionID).replaceAll(".", "%2E") || "unknown-session"
            const file = await save(
              attachmentRoot(),
              session,
              safeName(part.filename, part.id),
              content.bytes,
              claimed,
              active,
            )
            appendText(
              `Attached file saved to: ${file} (${part.mime || "unknown MIME type"}, ${content.bytes.byteLength} bytes)`,
            )
          })
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error)
            console.error(`[attachment-materialize] ${label}: ${message}`)
            appendText(`Attachment materialization failed for ${label}: ${message}`)
          })
      }
    },
  }
}
