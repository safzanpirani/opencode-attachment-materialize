import type { Plugin } from "@opencode-ai/plugin"
import { randomUUID } from "node:crypto"
import { mkdir, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { extname, join, resolve } from "node:path"

const MAX_FILE_BYTES = 25 * 1024 * 1024
const MAX_NAME_BYTES = 180
const MAX_EXTENSION_BYTES = 24

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

const attachmentRoot = () => {
  if (process.env.OPENCODE_ATTACHMENT_DIR) return resolve(process.env.OPENCODE_ATTACHMENT_DIR)
  const data = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
  return join(data, "opencode", "v1-attachments")
}

const decodedSize = (payload: string) => {
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0
  return (payload.length / 4) * 3 - padding
}

const decode = (url: string) => {
  const comma = url.indexOf(",")
  if (comma < 5 || !/(?:^|;)base64$/i.test(url.slice(5, comma))) {
    throw new Error("attachment is not a base64 data URL")
  }
  const payload = url.slice(comma + 1)
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0
  const firstPadding = payload.indexOf("=")
  if (
    payload.length % 4 !== 0 ||
    /[^A-Za-z0-9+/=]/.test(payload) ||
    (firstPadding !== -1 && firstPadding < payload.length - padding)
  ) {
    throw new Error("attachment has invalid base64 data")
  }
  const size = decodedSize(payload)
  if (size > MAX_FILE_BYTES) return { status: "oversize" as const, size }
  const bytes = Buffer.from(payload, "base64")
  if (bytes.byteLength !== size) throw new Error("attachment base64 length is invalid")
  return { status: "decoded" as const, bytes }
}

const existingSize = (file: string) =>
  stat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })

const save = async (directory: string, name: string, bytes: Buffer) => {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  for (let count = 1; ; count++) {
    const file = join(directory, suffixedName(name, count))
    const info = await existingSize(file)
    if (info?.isFile() && info.size === bytes.byteLength) return file
    if (info) continue
    const written = await writeFile(file, bytes, { flag: "wx", mode: 0o600 })
      .then(() => true)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "EEXIST") return false
        throw error
      })
    if (written) return file
    const raced = await existingSize(file)
    if (raced?.isFile() && raced.size === bytes.byteLength) return file
  }
}

export const AttachmentMaterialize: Plugin = async () => ({
  "chat.message": async (input, output) => {
    for (const part of output.parts.slice()) {
      if (part.type !== "file" || !part.url.startsWith("data:")) continue
      await Promise.resolve()
        .then(async () => {
          const content = decode(part.url)
          if (content.status === "oversize") {
            output.parts.push({
              id: `prt_${randomUUID().replaceAll("-", "")}`,
              sessionID: part.sessionID,
              messageID: part.messageID,
              type: "text",
              synthetic: true,
              text: `Attachment not materialized: ${part.filename || "unnamed file"} is ${content.size} bytes and exceeds the 25 MiB limit.`,
            })
            return
          }
          const directory = join(attachmentRoot(), encodeURIComponent(input.sessionID) || "unknown-session")
          const file = await save(directory, safeName(part.filename, part.id), content.bytes)
          output.parts.push({
            id: `prt_${randomUUID().replaceAll("-", "")}`,
            sessionID: part.sessionID,
            messageID: part.messageID,
            type: "text",
            synthetic: true,
            text: `Attached file saved to: ${file} (${part.mime}, ${content.bytes.byteLength} bytes)`,
          })
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          console.error(`[attachment-materialize] ${part.filename || "unnamed file"}: ${message}`)
          output.parts.push({
            id: `prt_${randomUUID().replaceAll("-", "")}`,
            sessionID: part.sessionID,
            messageID: part.messageID,
            type: "text",
            synthetic: true,
            text: `Attachment materialization failed for ${part.filename || "unnamed file"}: ${message}`,
          })
        })
    }
  },
})
