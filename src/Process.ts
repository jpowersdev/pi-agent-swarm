import { execFile } from "node:child_process"

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

export class Error extends Schema.TaggedError<Error>()("ProcessError", {
  command: Schema.String,
  message: Schema.String
}) {}

export interface Result {
  readonly command: string
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export const run = Effect.fn("Process.run")(function* (
  command: string,
  args: ReadonlyArray<string>,
  options: {
    readonly cwd?: string
    readonly timeoutMillis?: number
  } = {}
) {
  return yield* Effect.tryPromise({
    try: (signal) => new Promise<Result>((resolve, reject) => {
      execFile(command, args, {
        cwd: options.cwd,
        signal,
        timeout: options.timeoutMillis,
        maxBuffer: 10 * 1024 * 1024,
        encoding: "utf8"
      }, (error, stdout, stderr) => {
        if (error !== null && typeof error.code !== "number") {
          reject(error)
          return
        }

        resolve({
          command: [command, ...args].join(" "),
          exitCode: error === null ? 0 : typeof error.code === "number" ? error.code : 1,
          stdout,
          stderr
        })
      })
    }),
    catch: (cause) => new Error({
      command: [command, ...args].join(" "),
      message: cause instanceof globalThis.Error ? cause.message : String(cause)
    })
  })
})

export const successful = Effect.fn("Process.successful")(function* (
  command: string,
  args: ReadonlyArray<string>,
  options: {
    readonly cwd?: string
    readonly timeoutMillis?: number
  } = {}
) {
  const result = yield* run(command, args, options)

  if (result.exitCode !== 0) {
    return yield* new Error({
      command: result.command,
      message: (result.stderr || result.stdout || `Exited with ${result.exitCode}`).trim()
    })
  }

  return result
})
