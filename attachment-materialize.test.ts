import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { AttachmentMaterialize } from "./attachment-materialize"

type Hook = NonNullable<Awaited<ReturnType<typeof AttachmentMaterialize>>["chat.message"]>
type Output = Parameters<Hook>[1]
type Part = Output["parts"][number]

const previous = process.env.OPENCODE_ATTACHMENT_DIR
let root = ""

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "opencode-v1-attachments-"))
  process.env.OPENCODE_ATTACHMENT_DIR = root
})

afterEach(async () => {
  if (previous === undefined) delete process.env.OPENCODE_ATTACHMENT_DIR
  if (previous !== undefined) process.env.OPENCODE_ATTACHMENT_DIR = previous
  await rm(root, { recursive: true, force: true })
})

const file = (input: { id?: string; name?: string; bytes?: Buffer; mime?: string; url?: string }): Part => ({
  id: input.id ?? "prt_file",
  sessionID: "ses_test",
  messageID: "msg_test",
  type: "file",
  mime: input.mime ?? "application/octet-stream",
  filename: input.name,
  url: input.url ?? `data:${input.mime ?? "application/octet-stream"};base64,${(input.bytes ?? Buffer.from("test")).toString("base64")}`,
})

const run = async (parts: Part[]) => {
  const hooks = await AttachmentMaterialize({} as never)
  const output: Output = {
    message: {
      id: "msg_test",
      sessionID: "ses_test",
      role: "user",
      time: { created: Date.now() },
      agent: "build",
      model: { providerID: "test", modelID: "test" },
    },
    parts,
  }
  await hooks["chat.message"]?.({ sessionID: "ses_test", messageID: "msg_test" }, output)
  return output
}

const savedPath = (output: Output) => {
  const note = output.parts.findLast((part) => part.type === "text" && part.text.startsWith("Attached file saved to:"))
  expect(note?.type).toBe("text")
  if (!note || note.type !== "text") throw new Error("missing saved-path note")
  return note.text.slice("Attached file saved to: ".length, note.text.lastIndexOf(" ("))
}

describe("attachment materialization", () => {
  test("writes exact bytes and appends the absolute path", async () => {
    const bytes = Buffer.from([0x00, 0x01, 0xfe, 0xff])
    const original = file({ name: "sample.bin", bytes })
    const output = await run([original])
    const path = savedPath(output)

    expect(output.parts[0]).toEqual(original)
    expect(await readFile(path)).toEqual(bytes)
    expect(path).toBe(join(root, "ses_test", "sample.bin"))
    expect(output.parts.at(-1)).toMatchObject({ type: "text", synthetic: true })
  })

  test("sanitizes traversal, bidi controls, empty names, and Windows devices", async () => {
    const cases = [
      ["prt_traversal", "../../secret.txt", "secret.txt"],
      ["prt_bidi", "report\u202Egnp.exe", "reportgnp.exe"],
      ["prt_empty", "", "attachment-prt_empty"],
      ["prt_device", "CON.txt", "_CON.txt"],
    ] as const

    for (const [id, name, expected] of cases) {
      const output = await run([file({ id, name })])
      expect(basename(savedPath(output))).toBe(expected)
    }
  })

  test("suffixes collisions and reuses an identical-length retry", async () => {
    const first = savedPath(await run([file({ id: "prt_one", name: "report.txt", bytes: Buffer.from("one") })]))
    const second = savedPath(await run([file({ id: "prt_two", name: "report.txt", bytes: Buffer.from("four") })]))
    const retry = savedPath(await run([file({ id: "prt_one", name: "report.txt", bytes: Buffer.from("one") })]))

    expect(basename(first)).toBe("report.txt")
    expect(basename(second)).toBe("report-2.txt")
    expect(retry).toBe(first)
    expect((await readdir(join(root, "ses_test"))).sort()).toEqual(["report-2.txt", "report.txt"])
  })

  test("skips attachments above 25 MiB", async () => {
    const bytes = Buffer.alloc(25 * 1024 * 1024 + 1)
    const original = file({ name: "large.bin", bytes })
    const output = await run([original])

    expect(output.parts[0]).toEqual(original)
    expect(output.parts.at(-1)).toMatchObject({
      type: "text",
      synthetic: true,
      text: expect.stringContaining("exceeds the 25 MiB limit"),
    })
    expect(await readdir(root)).toEqual([])
  })

  test("reports corrupt base64 without rejecting the turn", async () => {
    const output = await run([file({ name: "bad.bin", url: "data:application/octet-stream;base64,%%%=" })])

    expect(output.parts).toHaveLength(2)
    expect(output.parts.at(-1)).toMatchObject({
      type: "text",
      synthetic: true,
      text: expect.stringContaining("materialization failed"),
    })
  })

  test("reports an unwritable attachment root without rejecting the turn", async () => {
    const blocked = join(root, "blocked")
    await writeFile(blocked, "not a directory")
    process.env.OPENCODE_ATTACHMENT_DIR = blocked
    const output = await run([file({ name: "blocked.bin" })])

    expect(output.parts).toHaveLength(2)
    expect(output.parts.at(-1)).toMatchObject({
      type: "text",
      synthetic: true,
      text: expect.stringContaining("materialization failed"),
    })
  })

  test("leaves file URLs untouched", async () => {
    const path = join(root, "source.txt")
    await writeFile(path, "source")
    const original = file({ name: "source.txt", url: new URL(`file://${path}`).href })
    const output = await run([original])

    expect(output.parts).toEqual([original])
  })
})
