import * as it from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"

import * as Process from "../src/Process.js"
import * as Workspace from "../src/Workspace.js"

it.effect("edits a VFS clone and commits it to the source repository", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const repository = yield* fs.makeTempDirectoryScoped({ prefix: "pi-agent-swarm-test-" })

    yield* Process.successful("git", ["init", "-b", "main"], { cwd: repository })
    yield* fs.makeDirectory(`${repository}/src`)
    yield* fs.writeFileString(`${repository}/src/value.js`, "export const value = 1\n")
    yield* Process.successful("git", ["add", "."], { cwd: repository })
    yield* Process.successful("git", [
      "-c", "user.name=Test",
      "-c", "user.email=test@example.invalid",
      "commit", "-m", "base"
    ], { cwd: repository })

    const workspace = yield* Workspace.make(repository)
    it.expect(yield* workspace.read("src/value.js")).toContain("value = 1")

    yield* workspace.edit("src/value.js", "value = 1", "value = 2")
    yield* workspace.write("notes/result.txt", "created in VFS\n")

    it.expect(yield* workspace.list("notes")).toEqual(["result.txt"])

    const checkpoint = yield* workspace.checkpoint("test")
    it.expect(checkpoint.created).toBe(true)
    it.expect(yield* fs.readFileString(`${repository}/src/value.js`)).toContain("value = 2")
    it.expect(yield* fs.readFileString(`${repository}/notes/result.txt`)).toBe("created in VFS\n")

    const subject = yield* Process.successful("git", ["show", "-s", "--format=%s", checkpoint.commit], {
      cwd: repository
    })
    it.expect(subject.stdout.trim()).toBe("agent checkpoint 1: test")

    const unchanged = yield* workspace.checkpoint("unchanged")
    it.expect(unchanged).toEqual({ commit: checkpoint.commit, created: false })
  }).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer)
  ))
