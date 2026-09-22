import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

import * as Execution from "./Execution.js"

export class Error extends Schema.TaggedError<Error>()("ExecutionStoreError", {
  operation: Schema.Literals(["cancel", "complete", "create", "get", "list", "open", "start"]),
  cause: Schema.Defect()
}) {}

export interface Interface {
  readonly create: (executionId: string, request: Execution.Request) => Effect.Effect<Execution.Record, Error>
  readonly get: (executionId: string) => Effect.Effect<Option.Option<Execution.Record>, Error>
  readonly list: () => Effect.Effect<ReadonlyArray<Execution.Record>, Error>
  readonly start: (
    executionId: string,
    runnerAddress: string
  ) => Effect.Effect<Option.Option<Execution.Record>, Error>
  readonly complete: (
    executionId: string,
    outcome: Execution.Outcome
  ) => Effect.Effect<Execution.Record, Error>
  readonly cancel: (executionId: string) => Effect.Effect<boolean, Error>
}

export class Service extends Context.Service<Service, Interface>()("pi-agent-swarm/ExecutionStore") {}

const failure = (operation: Error["operation"], cause: unknown) => new Error({ operation, cause })

export const layerMemory: Layer.Layer<Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const records = new Map<string, Execution.Record>()

    const get: Interface["get"] = Effect.fn("ExecutionStore.Memory.get")((executionId) =>
      Effect.succeed(Option.fromNullishOr(records.get(executionId))))

    const create: Interface["create"] = Effect.fn("ExecutionStore.Memory.create")(
      function* (executionId, request) {
        const existing = records.get(executionId)
        if (existing !== undefined) {
          if (existing.commit !== request.commit || existing.action !== request.action) {
            return yield* Effect.fail(failure(
              "create",
              new globalThis.Error(`Execution id ${executionId} was already used for a different request`)
            ))
          }
          return existing
        }

        const execution: Execution.Record = {
          executionId,
          commit: request.commit,
          action: request.action,
          state: "queued",
          submittedAt: yield* Clock.currentTimeMillis,
          runnerAddress: null,
          startedAt: null,
          finishedAt: null,
          exitCode: null,
          output: null,
          durationMillis: null
        }
        records.set(executionId, execution)
        return execution
      }
    )

    const list: Interface["list"] = Effect.fn("ExecutionStore.Memory.list")(() =>
      Effect.succeed(Array.from(records.values()).sort((left, right) =>
        left.submittedAt - right.submittedAt || left.executionId.localeCompare(right.executionId)
      )))

    const start: Interface["start"] = Effect.fn("ExecutionStore.Memory.start")(
      function* (executionId, runnerAddress) {
        const execution = records.get(executionId)
        if (execution === undefined || execution.state !== "queued") return Option.none()

        const running: Execution.Record = {
          ...execution,
          state: "running",
          runnerAddress,
          startedAt: yield* Clock.currentTimeMillis
        }
        records.set(executionId, running)
        return Option.some(running)
      }
    )

    const complete: Interface["complete"] = Effect.fn("ExecutionStore.Memory.complete")(
      function* (executionId, outcome) {
        const execution = records.get(executionId)
        if (execution === undefined) {
          return yield* Effect.fail(failure(
            "complete",
            new globalThis.Error(`Unknown execution: ${executionId}`)
          ))
        }
        if (execution.state !== "running") return execution

        const completed: Execution.Record = {
          ...execution,
          state: outcome.passed ? "succeeded" : "failed",
          finishedAt: yield* Clock.currentTimeMillis,
          exitCode: outcome.exitCode,
          output: outcome.output,
          durationMillis: outcome.durationMillis
        }
        records.set(executionId, completed)
        return completed
      }
    )

    const cancel: Interface["cancel"] = Effect.fn("ExecutionStore.Memory.cancel")(function* (executionId) {
      const execution = records.get(executionId)
      if (execution === undefined || Execution.isTerminal(execution)) return false

      records.set(executionId, {
        ...execution,
        state: "cancelled",
        finishedAt: yield* Clock.currentTimeMillis,
        output: "Cancelled"
      })
      return true
    })

    return Service.of({ create, get, list, start, complete, cancel })
  })
)
