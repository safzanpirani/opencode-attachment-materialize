import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, isAbsolute, join, relative } from "node:path"
import { AttachmentMaterialize } from "./attachment-materialize"

type Hook = NonNullable<Awaited<ReturnType<typeof AttachmentMaterialize>>["chat.message"]>
type Hooks = Awaited<ReturnType<typeof AttachmentMaterialize>>
type Output = Parameters<Hook>[1]
type Part = Output["parts"][number]

const previous = process.env.OPENCODE_ATTACHMENT_DIR
const previousXdg = process.env.XDG_DATA_HOME
const previousMaxBytes = process.env.OPENCODE_ATTACHMENT_MAX_BYTES
const previousMaxFiles = process.env.OPENCODE_ATTACHMENT_MAX_FILES
let root = ""

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "opencode-v1-attachments-"))
  process.env.OPENCODE_ATTACHMENT_DIR = root
  delete process.env.OPENCODE_ATTACHMENT_MAX_BYTES
  delete process.env.OPENCODE_ATTACHMENT_MAX_FILES
})

afterEach(async () => {
  if (previous === undefined) delete process.env.OPENCODE_ATTACHMENT_DIR
  if (previous !== undefined) process.env.OPENCODE_ATTACHMENT_DIR = previous
  if (previousXdg === undefined) delete process.env.XDG_DATA_HOME
  if (previousXdg !== undefined) process.env.XDG_DATA_HOME = previousXdg
  if (previousMaxBytes === undefined) delete process.env.OPENCODE_ATTACHMENT_MAX_BYTES
  else process.env.OPENCODE_ATTACHMENT_MAX_BYTES = previousMaxBytes
  if (previousMaxFiles === undefined) delete process.env.OPENCODE_ATTACHMENT_MAX_FILES
  else process.env.OPENCODE_ATTACHMENT_MAX_FILES = previousMaxFiles
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
const oldAttachment = async (session: string, bytes = "test") => {
  const directory = join(root, session)
  await mkdir(directory)
  const path = join(directory, "old.bin")
  await writeFile(path, bytes)
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
  await utimes(directory, old, old)
  return path
}

const storageHooks = async (options: {
  sessions?: { id: string; directory: string; parentID?: string }[]
  histories?: Record<string, unknown[]>
  failHistory?: string
} = {}) => {
  const queried: string[] = []
  const hooks = await AttachmentMaterialize({
    directory: "/project-one",
    client: {
      project: { list: async () => ({ data: [{ worktree: "/project-two" }] }) },
      session: {
        list: async ({ query }: { query: { directory: string } }) => {
          queried.push(query.directory)
          return { data: (options.sessions ?? []).filter((session) => session.directory === query.directory) }
        },
        messages: async ({ path }: { path: { id: string } }) => {
          if (path.id === options.failHistory) throw new Error("history unavailable")
          return { data: options.histories?.[path.id] ?? [] }
        },
      },
    },
  } as never)
  return { hooks, queried }
}

describe("bounded attachment storage", () => {
  test("enforces byte quota across instances and preserves existing paths and retries", async () => {
    process.env.OPENCODE_ATTACHMENT_MAX_BYTES = "4"
    const firstHooks = await AttachmentMaterialize({} as never)
    const secondHooks = await AttachmentMaterialize({} as never)
    const outputs = await Promise.all([
      run([file({ name: "first.bin" })], { sessionID: "ses_one" }, firstHooks),
      run([file({ name: "second.bin" })], { sessionID: "ses_two" }, secondHooks),
    ])
    expect(outputs.flatMap(savedPaths)).toHaveLength(1)
    const successful = outputs.find((output) => savedPaths(output).length === 1)!
    const path = savedPath(successful)
    const retry = await run([file({ name: basename(path) })], { sessionID: successful.message.sessionID })
    expect(savedPath(retry)).toBe(path)
    expect(await readFile(path, "utf8")).toBe("test")
    expect(outputs.find((output) => savedPaths(output).length === 0)?.parts.at(-1)).toMatchObject({
      type: "text", text: expect.stringContaining("storage quota reached"),
    })
    expect(await readdir(root)).toEqual([successful.message.sessionID])
  })

  test("bounds zero-byte files by count and rejects invalid quota configuration", async () => {
    process.env.OPENCODE_ATTACHMENT_MAX_FILES = "1"
    const output = await run([
      file({ name: "empty.bin", bytes: Buffer.alloc(0) }),
      file({ name: "another.bin", bytes: Buffer.alloc(0) }),
    ])
    expect(savedPaths(output)).toHaveLength(1)
    expect(output.parts.at(-1)).toMatchObject({ type: "text", text: expect.stringContaining("storage quota reached") })
    process.env.OPENCODE_ATTACHMENT_MAX_BYTES = "0"
    const invalid = await run([file({ name: "invalid.bin" })])
    expect(savedPaths(invalid)).toEqual([])
    expect(invalid.parts.at(-1)).toMatchObject({ type: "text", text: expect.stringContaining("must be a positive integer") })
  })

  test("cleans only old unowned directories, preserving historical, forked and cross-project paths", async () => {
    const historical = await oldAttachment("ses_historical")
    const forked = await oldAttachment("ses_forked")
    const referenced = await oldAttachment("ses_referenced")
    const unowned = await oldAttachment("ses_unowned")
    const foreign = await oldAttachment("not-a-session")
    await mkdir(join(root, "ses_recent"))
    await writeFile(join(root, "ses_recent", "recent.bin"), "recent")
    const { hooks, queried } = await storageHooks({
      sessions: [
        { id: "ses_historical", directory: "/project-one" },
        { id: "ses_child", directory: "/project-one", parentID: "ses_forked" },
        { id: "ses_other", directory: "/project-two" },
      ],
      histories: { ses_other: [{ parts: [{ type: "tool", state: { input: { path: referenced } } }] }] },
    })
    await run([file({ name: "new.bin" })], {}, hooks)
    expect(queried.sort()).toEqual(["/project-one", "/project-two"])
    expect(await readFile(historical, "utf8")).toBe("test")
    expect(await readFile(forked, "utf8")).toBe("test")
    expect(await readFile(referenced, "utf8")).toBe("test")
    expect(await readFile(foreign, "utf8")).toBe("test")
    expect(await readFile(join(root, "ses_recent", "recent.bin"), "utf8")).toBe("recent")
    expect(await Bun.file(unowned).exists()).toBe(false)
  })

  test("reclaims orphan bytes before enforcing quota and sweeps on session deletion", async () => {
    process.env.OPENCODE_ATTACHMENT_MAX_BYTES = "4"
    const orphan = await oldAttachment("ses_orphan")
    const { hooks } = await storageHooks()
    const output = await run([file({ name: "new.bin" })], {}, hooks)
    expect(await readFile(savedPath(output), "utf8")).toBe("test")
    expect(await Bun.file(orphan).exists()).toBe(false)
    const deleted = await oldAttachment("ses_deleted")
    await hooks.event?.({ event: { type: "session.deleted", properties: { info: { id: "ses_deleted" } } } } as never)
    expect(await Bun.file(deleted).exists()).toBe(false)
  })

  test("incomplete history scans fail closed without partially deleting or breaking the turn", async () => {
    const first = await oldAttachment("ses_first")
    const second = await oldAttachment("ses_second")
    const { hooks } = await storageHooks({
      sessions: [{ id: "ses_reader", directory: "/project-one" }], failHistory: "ses_reader",
    })
    const output = await run([file({ name: "new.bin" })], {}, hooks)
    expect(savedPaths(output)).toHaveLength(1)
    expect(await readFile(first, "utf8")).toBe("test")
    expect(await readFile(second, "utf8")).toBe("test")
    expect(await readdir(root)).not.toContain(".materialize-lock")
  })

  test("never traverses symlinked session directories during accounting or cleanup", async () => {
    const outside = join(root, "outside")
    await mkdir(outside)
    const path = join(outside, "keep.bin")
    await writeFile(path, "keep")
    await symlink(outside, join(root, "ses_link"), "dir")
    const { hooks } = await storageHooks()
    await run([file({ name: "new.bin" })], {}, hooks)
    expect(await readFile(path, "utf8")).toBe("keep")
    expect(await readdir(root)).toContain("ses_link")
  })
})


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
