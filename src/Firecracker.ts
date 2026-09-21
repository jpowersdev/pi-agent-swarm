import * as NodePath from "node:path"

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import * as Process from "./Process.js"

export class Error extends Schema.TaggedError<Error>()("FirecrackerError", {
  operation: Schema.Literals(["execute"]),
  message: Schema.String
}) {}

export interface TestResult {
  readonly commit: string
  readonly passed: boolean
  readonly exitCode: number
  readonly output: string
  readonly durationMillis: number
}

export interface Firecracker {
  readonly test: (repository: string, commit: string) => Effect.Effect<TestResult, Error>
}

export const make = (projectRoot: string): Firecracker => {
  const script = NodePath.join(projectRoot, "scripts/run-firecracker")

  const test: Firecracker["test"] = Effect.fn("Firecracker.test")(function* (repository, commit) {
    const startedAt = Date.now()
    const result = yield* Process.run(script, [repository, commit], {
      cwd: projectRoot,
      timeoutMillis: 45_000
    }).pipe(
      Effect.mapError((cause) => new Error({ operation: "execute", message: cause.message }))
    )

    if (result.exitCode !== 0 && result.exitCode !== 1) {
      return yield* new Error({
        operation: "execute",
        message: (result.stderr || result.stdout || `Executor exited with ${result.exitCode}`).trim()
      })
    }

    return {
      commit,
      passed: result.exitCode === 0,
      exitCode: result.exitCode,
      output: [result.stdout, result.stderr].filter((part) => part !== "").join("\n").trim(),
      durationMillis: Date.now() - startedAt
    }
  })

  return { test }
}
