import * as NodeFs from "node:fs/promises"
import * as NodePath from "node:path"

import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Semaphore from "effect/Semaphore"

import * as Process from "./Process.js"

export class Error extends Schema.TaggedError<Error>()("WorkspaceError", {
  operation: Schema.Literals(["checkpoint", "edit", "list", "load", "read", "write"]),
  message: Schema.String
}) {}

export interface Checkpoint {
  readonly commit: string
  readonly created: boolean
}

export interface Workspace {
  readonly repository: string
  readonly read: (path: string) => Effect.Effect<string, Error>
  readonly list: (path: string) => Effect.Effect<ReadonlyArray<string>, Error>
  readonly write: (path: string, content: string) => Effect.Effect<void, Error>
  readonly edit: (path: string, oldText: string, newText: string) => Effect.Effect<void, Error>
  readonly checkpoint: (reason: string) => Effect.Effect<Checkpoint, Error>
}

const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })

const failureMessage = (cause: unknown): string =>
  cause instanceof globalThis.Error ? cause.message : String(cause)

const workspaceError = (
  operation: Error["operation"],
  cause: unknown
) => new Error({ operation, message: failureMessage(cause) })

const relativePath = (input: string): Effect.Effect<string, Error> => Effect.gen(function* () {
  if (input.startsWith("/") || input.includes("\\")) {
    return yield* workspaceError("read", "Paths must be relative and use forward slashes")
  }

  const segments = input.split("/").filter((segment) => segment !== "" && segment !== ".")
  if (segments.includes("..")) {
    return yield* workspaceError("read", "Path traversal is not allowed")
  }

  return segments.join("/")
})

const vfsPath = (relative: string) => relative === "" ? "/project" : `/project/${relative}`

interface MaterializedFile {
  readonly path: string
  readonly bytes: Uint8Array
}

export const make = Effect.fn("Workspace.make")(function* (repository: string) {
  const checkpointGate = yield* Semaphore.make(1)

  const listed = yield* Process.successful("git", ["ls-files", "-z"], { cwd: repository }).pipe(
    Effect.mapError((cause) => workspaceError("load", cause))
  )
  const tracked = listed.stdout.split("\0").filter((path) => path !== "")

  const directories = new Set<string>(["/project"])
  for (const file of tracked) {
    const segments = file.split("/")
    for (let index = 1; index < segments.length; index++) {
      directories.add(`/project/${segments.slice(0, index).join("/")}`)
    }
  }

  const entries: Array<Vfs.Fixture["entries"][number]> = [...directories]
    .sort((left, right) => left.split("/").length - right.split("/").length || left.localeCompare(right))
    .map((path) => ({ kind: "directory" as const, path }))

  for (const path of tracked) {
    const bytes = yield* Effect.tryPromise({
      try: () => NodeFs.readFile(NodePath.join(repository, path)),
      catch: (cause) => workspaceError("load", cause)
    })
    entries.push({ kind: "file", path: vfsPath(path), bytes })
  }

  const template = yield* Vfs.fromFixture({ entries }).pipe(
    Effect.mapError((cause) => workspaceError("load", cause))
  )
  const overlay = yield* Vfs.makeOverlay(yield* template.snapshot).pipe(
    Effect.mapError((cause) => workspaceError("load", cause))
  )
  const caller = yield* overlay.caller()

  const normalize = (path: string, operation: Error["operation"]) => relativePath(path).pipe(
    Effect.mapError((cause) => new Error({ operation, message: cause.message }))
  )

  const ensureParents = Effect.fn("Workspace.ensureParents")(function* (path: string) {
    const segments = path.split("/").slice(0, -1)
    for (let index = 1; index <= segments.length; index++) {
      yield* caller.mkdir(vfsPath(segments.slice(0, index).join("/"))).pipe(
        Effect.catch((cause) => cause.code === "AlreadyExists" ? Effect.void : Effect.fail(cause))
      )
    }
  })

  const read: Workspace["read"] = Effect.fn("Workspace.read")(function* (path) {
    const normalized = yield* normalize(path, "read")
    const bytes = yield* caller.readFile(vfsPath(normalized)).pipe(
      Effect.mapError((cause) => workspaceError("read", cause))
    )

    return yield* Effect.try({
      try: () => decoder.decode(bytes),
      catch: (cause) => workspaceError("read", cause)
    })
  })

  const list: Workspace["list"] = Effect.fn("Workspace.list")(function* (path) {
    const normalized = yield* normalize(path, "list")
    return yield* caller.readDirectory(vfsPath(normalized)).pipe(
      Effect.map((entries) => [...entries].sort()),
      Effect.mapError((cause) => workspaceError("list", cause))
    )
  })

  const write: Workspace["write"] = Effect.fn("Workspace.write")(function* (path, content) {
    const normalized = yield* normalize(path, "write")
    if (normalized === "") return yield* workspaceError("write", "Cannot write the project root")

    yield* ensureParents(normalized).pipe(
      Effect.mapError((cause) => workspaceError("write", cause))
    )
    yield* caller.writeFile(vfsPath(normalized), encoder.encode(content), {
      access: "write",
      create: "ifMissing",
      truncate: true
    }).pipe(Effect.mapError((cause) => workspaceError("write", cause)))
  })

  const edit: Workspace["edit"] = Effect.fn("Workspace.edit")(function* (path, oldText, newText) {
    if (oldText === "") return yield* workspaceError("edit", "oldText must not be empty")

    const current = yield* read(path).pipe(
      Effect.mapError((cause) => new Error({ operation: "edit", message: cause.message }))
    )
    const first = current.indexOf(oldText)
    if (first === -1) return yield* workspaceError("edit", "oldText was not found")
    if (current.indexOf(oldText, first + oldText.length) !== -1) {
      return yield* workspaceError("edit", "oldText must match exactly once")
    }

    yield* write(path, current.slice(0, first) + newText + current.slice(first + oldText.length)).pipe(
      Effect.mapError((cause) => new Error({ operation: "edit", message: cause.message }))
    )
  })

  const materializedFiles = Effect.fn("Workspace.materializedFiles")(function* () {
    const files: Array<MaterializedFile> = []

    const walk = Effect.fn("Workspace.walk")(function* (directory: string): Effect.fn.Return<void, Error> {
      const names = yield* caller.readDirectory(vfsPath(directory)).pipe(
        Effect.mapError((cause) => workspaceError("checkpoint", cause))
      )

      for (const name of [...names].sort()) {
        const relative = directory === "" ? name : `${directory}/${name}`
        const metadata = yield* caller.lstat(vfsPath(relative)).pipe(
          Effect.mapError((cause) => workspaceError("checkpoint", cause))
        )

        if (metadata.kind === "directory") {
          yield* walk(relative)
        } else if (metadata.kind === "file") {
          const bytes = yield* caller.readFile(vfsPath(relative)).pipe(
            Effect.mapError((cause) => workspaceError("checkpoint", cause))
          )
          files.push({ path: relative, bytes })
        } else {
          return yield* workspaceError("checkpoint", `Unsupported VFS entry kind: ${metadata.kind}`)
        }
      }
    })

    yield* walk("")
    return files
  })

  let sequence = 0
  const checkpoint: Workspace["checkpoint"] = (reason) => checkpointGate.withPermits(1)(Effect.gen(function* () {
    const files = yield* materializedFiles()
    const hostEntries = yield* Effect.tryPromise({
      try: () => NodeFs.readdir(repository),
      catch: (cause) => workspaceError("checkpoint", cause)
    })

    yield* Effect.forEach(hostEntries.filter((entry) => entry !== ".git"), (entry) => Effect.tryPromise({
      try: () => NodeFs.rm(NodePath.join(repository, entry), { recursive: true, force: true }),
      catch: (cause) => workspaceError("checkpoint", cause)
    }), { discard: true })

    yield* Effect.forEach(files, (file) => Effect.tryPromise({
      try: async () => {
        const destination = NodePath.join(repository, file.path)
        await NodeFs.mkdir(NodePath.dirname(destination), { recursive: true })
        await NodeFs.writeFile(destination, file.bytes)
      },
      catch: (cause) => workspaceError("checkpoint", cause)
    }), { discard: true })

    yield* Process.successful("git", ["add", "-A"], { cwd: repository }).pipe(
      Effect.mapError((cause) => workspaceError("checkpoint", cause))
    )
    const status = yield* Process.successful("git", ["status", "--porcelain"], { cwd: repository }).pipe(
      Effect.mapError((cause) => workspaceError("checkpoint", cause))
    )

    const created = status.stdout.trim() !== ""
    if (created) {
      sequence += 1
      yield* Process.successful("git", [
        "-c", "user.name=Pi Agent Swarm",
        "-c", "user.email=swarm@example.invalid",
        "commit", "-m", `agent checkpoint ${sequence}: ${reason}`
      ], { cwd: repository }).pipe(
        Effect.mapError((cause) => workspaceError("checkpoint", cause))
      )
    }

    const head = yield* Process.successful("git", ["rev-parse", "HEAD"], { cwd: repository }).pipe(
      Effect.mapError((cause) => workspaceError("checkpoint", cause))
    )

    return { commit: head.stdout.trim(), created }
  }))

  return { repository, read, list, write, edit, checkpoint } satisfies Workspace
})
