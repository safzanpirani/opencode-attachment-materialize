import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, isAbsolute, join, relative } from "node:path"
import { AttachmentMaterialize } from "./attachment-materialize"

type Hook = NonNullable<Awaited<ReturnType<typeof AttachmentMaterialize>>["chat.message"]>
type Hooks = Awaited<ReturnType<typeof AttachmentMaterialize>>
type Output = Parameters<Hook>[1]
type Part = Output["parts"][number]

const previous = process.env.OPENCODE_ATTACHMENT_DIR
const previousXdg = process.env.XDG_DATA_HOME
let root = ""

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "opencode-v1-attachments-"))
  process.env.OPENCODE_ATTACHMENT_DIR = root
})

afterEach(async () => {
  if (previous === undefined) delete process.env.OPENCODE_ATTACHMENT_DIR
  if (previous !== undefined) process.env.OPENCODE_ATTACHMENT_DIR = previous
  if (previousXdg === undefined) delete process.env.XDG_DATA_HOME
  if (previousXdg !== undefined) process.env.XDG_DATA_HOME = previousXdg
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

const run = async (parts: Part[], identity: { sessionID?: string; messageID?: string } = {}, hooks?: Hooks) => {
  const sessionID = identity.sessionID ?? "ses_test"
  const messageID = identity.messageID ?? "msg_test"
  const activeHooks = hooks ?? (await AttachmentMaterialize({} as never))
  const output: Output = {
    message: {
      id: messageID,
      sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: "build",
      model: { providerID: "test", modelID: "test" },
    },
    parts,
  }
  await activeHooks["chat.message"]?.({ sessionID, messageID }, output)
  return output
}

const savedPaths = (output: Output) =>
  output.parts.flatMap((part) =>
    part.type === "text" && part.text.startsWith("Attached file saved to:")
      ? [part.text.slice("Attached file saved to: ".length, part.text.lastIndexOf(" ("))]
      : [],
  )

const savedPath = (output: Output) => {
  const path = savedPaths(output).at(-1)
  expect(path).toBeDefined()
  if (!path) throw new Error("missing saved-path note")
  return path
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
    expect(output.parts.at(-1)).toMatchObject({
      id: expect.stringMatching(/^prt_[0-9a-f]{32}$/),
      sessionID: "ses_test",
      messageID: "msg_test",
      type: "text",
      synthetic: true,
    })
  })

  test("sanitizes traversal, absolute paths, trailing dots, bidi controls, empty names, and Windows devices", async () => {
    const cases = [
      ["prt_traversal", "../../secret.txt", "secret.txt"],
      ["prt_absolute", "/etc/passwd", "passwd"],
      ["prt_windows_absolute", "C:\\Windows\\system.ini", "system.ini"],
      ["prt_encoded", "%2e%2e%2fsecret.txt", "%2e%2e%2fsecret.txt"],
      ["prt_trailing", "report.txt. ", "report.txt"],
      ["prt_bidi", "report\u202Egnp.exe", "reportgnp.exe"],
      ["prt_empty", "", "attachment-prt_empty"],
      ["prt_dot", "..", "attachment-prt_dot"],
      ["prt_device", "CON.txt", "_CON.txt"],
    ] as const

    for (const [id, name, expected] of cases) {
      const output = await run([file({ id, name })])
      const path = savedPath(output)
      expect(basename(path)).toBe(expected)
      expect(path.startsWith(`${join(root, "ses_test")}/`)).toBe(true)
    }
  })

  test("keeps a dot-only session ID inside the attachment root", async () => {
    const output = await run([file({ name: "sample.bin" })], { sessionID: "..", messageID: "msg_dot" })
    const path = savedPath(output)

    expect(path).toBe(join(root, "%2E%2E", "sample.bin"))
    expect(await readFile(path)).toEqual(Buffer.from("test"))
    expect(output.parts.at(-1)).toMatchObject({ sessionID: "..", messageID: "msg_dot" })
  })

  test("rejects NUL filenames without putting control characters in the failure note", async () => {
    const output = await run([file({ name: "bad\0\nname.bin" })])
    const note = output.parts.at(-1)

    expect(note).toMatchObject({ type: "text", synthetic: true })
    expect(note?.type === "text" ? note.text : "").toContain("badname.bin")
    expect(note?.type === "text" ? note.text : "").not.toContain("\0")
    expect(note?.type === "text" ? note.text : "").not.toContain("\n")
  })

  test("rejects a symlinked session directory without writing through it", async () => {
    const victim = join(root, "victim")
    await mkdir(victim)
    await symlink(victim, join(root, "ses_test"), "dir")
    const output = await run([file({ name: "escape.bin" })])

    expect(output.parts.at(-1)).toMatchObject({
      type: "text",
      text: expect.stringContaining("materialization failed"),
    })
    expect(await readdir(victim)).toEqual([])
  })

  test("does not reuse a file symlink with a matching target size", async () => {
    const directory = join(root, "ses_test")
    const victim = join(root, "victim.bin")
    await mkdir(directory)
    await writeFile(victim, "safe")
    await symlink(victim, join(directory, "report.bin"))
    const output = await run([file({ name: "report.bin", bytes: Buffer.from("evil") })])

    expect(basename(savedPath(output))).toBe("report-2.bin")
    expect(await readFile(victim, "utf8")).toBe("safe")
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

  test("keeps same-name equal-length parts in one message distinct", async () => {
    const output = await run([
      file({ id: "prt_one", name: "report.txt", bytes: Buffer.from("one") }),
      file({ id: "prt_two", name: "report.txt", bytes: Buffer.from("two") }),
    ])
    const paths = savedPaths(output)

    expect(paths.map((path) => basename(path))).toEqual(["report.txt", "report-2.txt"])
    expect(await readFile(paths[0])).toEqual(Buffer.from("one"))
    expect(await readFile(paths[1])).toEqual(Buffer.from("two"))
  })

  test("uses exclusive writes when two messages race in one session", async () => {
    const hooks = await AttachmentMaterialize({} as never)
    const [first, second] = await Promise.all([
      run([file({ name: "race.bin", bytes: Buffer.from("one") })], { messageID: "msg_one" }, hooks),
      run([file({ name: "race.bin", bytes: Buffer.from("two") })], { messageID: "msg_two" }, hooks),
    ])
    const firstPath = savedPath(first)
    const secondPath = savedPath(second)

    expect(firstPath).not.toBe(secondPath)
    expect(await readFile(firstPath)).toEqual(Buffer.from("one"))
    expect(await readFile(secondPath)).toEqual(Buffer.from("two"))
  })

  test("falls back to a bounded random suffix after numeric collisions", async () => {
    const directory = join(root, "ses_test")
    await mkdir(directory)
    for (let count = 1; count <= 1_000; count++) {
      const name = count === 1 ? "crowded.txt" : `crowded-${count}.txt`
      await writeFile(join(directory, name), "occupied")
    }
    const output = await run([file({ name: "crowded.txt", bytes: Buffer.from("new") })])
    const path = savedPath(output)

    expect(basename(path)).toMatch(/^crowded-[0-9a-f]{8}\.txt$/)
    expect(await readFile(path)).toEqual(Buffer.from("new"))
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

  test("materializes an attachment exactly at the 25 MiB limit", async () => {
    const bytes = Buffer.alloc(25 * 1024 * 1024, 0xa5)
    const output = await run([file({ name: "limit.bin", bytes })])

    expect(await readFile(savedPath(output))).toEqual(bytes)
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

  test("decodes charset, ASCII whitespace, URL-safe alphabet, and omitted padding", async () => {
    const output = await run([
      file({
        name: "variant.bin",
        url: "data:application/octet-stream;charset=utf-8;base64,-_ \n8",
      }),
    ])

    expect(await readFile(savedPath(output))).toEqual(Buffer.from([0xfb, 0xff]))
  })

  test("rejects missing base64 markers and non-canonical padding bits", async () => {
    const plain = await run([file({ name: "plain.txt", url: "data:text/plain,hello" })])
    const padded = await run([file({ name: "padded.bin", url: "data:application/octet-stream;base64,AB==" })])

    expect(plain.parts.at(-1)).toMatchObject({ type: "text", text: expect.stringContaining("materialization failed") })
    expect(padded.parts.at(-1)).toMatchObject({ type: "text", text: expect.stringContaining("materialization failed") })
  })

  test("uses an absolute XDG-derived root when XDG_DATA_HOME is relative", async () => {
    delete process.env.OPENCODE_ATTACHMENT_DIR
    process.env.XDG_DATA_HOME = relative(process.cwd(), root)
    const output = await run([file({ name: "xdg.bin" })])
    const path = savedPath(output)

    expect(isAbsolute(path)).toBe(true)
    expect(path).toBe(join(root, "opencode", "v1-attachments", "ses_test", "xdg.bin"))
  })

  test("generates a name and labels an empty MIME value", async () => {
    const output = await run([file({ mime: "", bytes: Buffer.from("unnamed") })])
    const path = savedPath(output)
    const note = output.parts.at(-1)

    expect(basename(path)).toBe("attachment-prt_file")
    expect(note?.type === "text" ? note.text : "").toContain("unknown MIME type")
    expect(await readFile(path)).toEqual(Buffer.from("unnamed"))
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

  test("leaves file URLs and non-file parts untouched", async () => {
    const path = join(root, "source.txt")
    await writeFile(path, "source")
    const original = file({ name: "source.txt", url: new URL(`file://${path}`).href })
    const text: Part = {
      id: "prt_text",
      sessionID: "ses_test",
      messageID: "msg_test",
      type: "text",
      text: "leave me alone",
    }
    const output = await run([original, text])

    expect(output.parts).toEqual([original, text])
  })
})
