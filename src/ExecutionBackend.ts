import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

import * as Execution from "./Execution.js"
import * as Firecracker from "./Firecracker.js"

export class Error extends Schema.TaggedError<Error>()("ExecutionBackendError", {
  operation: Schema.Literals(["execute"]),
  cause: Schema.Defect()
}) {}

export interface Interface {
  readonly execute: (execution: Execution.Record) => Effect.Effect<Execution.Outcome, Error>
}

export class Service extends Context.Service<Service, Interface>()("pi-agent-swarm/ExecutionBackend") {}

export const firecrackerLayer = (
  projectRoot: string,
  repository: string
): Layer.Layer<Service> =>
  Layer.succeed(Service, Service.of({
    execute: Effect.fn("ExecutionBackend.execute")(function* (execution) {
      if (execution.action !== "test") {
        return yield* Effect.fail(new Error({
          operation: "execute",
          cause: new globalThis.Error(`Unsupported action: ${execution.action}`)
        }))
      }

      const result = yield* Firecracker.make(projectRoot).test(repository, execution.commit).pipe(
        Effect.mapError((cause) => new Error({ operation: "execute", cause }))
      )

      return {
        passed: result.passed,
        exitCode: result.exitCode,
        output: result.output,
        durationMillis: result.durationMillis
      }
    })
  }))
