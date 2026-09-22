import * as Crypto from "effect/Crypto"
import * as Deferred from "effect/Deferred"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Ref from "effect/Ref"
import * as Schedule from "effect/Schedule"
import * as Scope from "effect/Scope"
import * as Entity from "effect/unstable/cluster/Entity"
import type * as Sharding from "effect/unstable/cluster/Sharding"

import * as Execution from "./Execution.js"
import * as ExecutionBackend from "./ExecutionBackend.js"
import * as ExecutionCapacity from "./ExecutionCapacity.js"
import * as ExecutionProtocol from "./ExecutionProtocol.js"
import * as ExecutionStore from "./ExecutionStore.js"
import * as Executions from "./Executions.js"

export interface RunnerOptions {
  readonly entityMaxIdleTime?: Duration.Input
}

const message = (cause: unknown): string => {
  if (typeof cause === "object" && cause !== null && "message" in cause) {
    return String(cause.message)
  }
  return String(cause)
}

const executionError = (
  executionId: string,
  operation: Executions.Error["operation"],
  cause: unknown
) => cause instanceof Executions.Error
  ? cause
  : new Executions.Error({ executionId, operation, message: message(cause) })

export const runnerLayer = (
  options: RunnerOptions = {}
): Layer.Layer<
  never,
  never,
  | ExecutionBackend.Service
  | ExecutionCapacity.Service
  | ExecutionStore.Service
  | Sharding.Sharding
> => {
  const handlers = Effect.gen(function* () {
    const address = yield* Entity.CurrentAddress
    const currentRunner = yield* Entity.CurrentRunnerAddress
    const activationScope = yield* Scope.Scope
    const backend = yield* ExecutionBackend.Service
    const capacity = yield* ExecutionCapacity.Service
    const store = yield* ExecutionStore.Service
    const executionId = address.entityId
    const runnerAddress = `${currentRunner.host}:${currentRunner.port}`
    const cancelSignal = yield* Deferred.make<void>()
    const runningFiber = yield* Ref.make<Option.Option<Fiber.Fiber<void>>>(Option.none())

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const fiber = yield* Ref.getAndSet(runningFiber, Option.none())
        if (Option.isSome(fiber)) yield* Fiber.interrupt(fiber.value)

        const execution = yield* store.get(executionId).pipe(Effect.orDie)
        if (Option.isSome(execution) && execution.value.state === "running") {
          yield* store.complete(executionId, {
            passed: false,
            exitCode: 125,
            output: "Execution entity deactivated before completion",
            durationMillis: 0
          }).pipe(Effect.orDie)
        }
      })
    )

    const start = Effect.fn("ExecutionEntity.start")(function* (request: Execution.Request) {
      const existing = yield* store.create(executionId, request).pipe(
        Effect.mapError((cause) => executionError(executionId, "submit", cause))
      )
      const localFiber = yield* Ref.get(runningFiber)

      if (existing.state === "running" && Option.isNone(localFiber)) {
        yield* store.complete(executionId, {
          passed: false,
          exitCode: 125,
          output: "Execution was orphaned by a previous entity activation",
          durationMillis: 0
        }).pipe(Effect.mapError((cause) => executionError(executionId, "submit", cause)))
        return
      }
      if (existing.state !== "queued" || Option.isSome(localFiber)) return

      yield* Effect.raceFirst(capacity.withPermit(Effect.gen(function* () {
        const started = yield* store.start(executionId, runnerAddress).pipe(
          Effect.mapError((cause) => executionError(executionId, "submit", cause))
        )
        if (Option.isNone(started)) return

        const gate = yield* Deferred.make<void>()
        const background = Deferred.await(gate).pipe(
          Effect.andThen(
            backend.execute(started.value).pipe(
              Effect.catch((cause) => Effect.succeed({
                passed: false,
                exitCode: 125,
                output: `Execution backend failed: ${message(cause)}`,
                durationMillis: 0
              })),
              Effect.flatMap((outcome) => store.complete(executionId, outcome)),
              Effect.tapError((cause) => Effect.logError("Could not persist execution result", cause)),
              Effect.ignore
            )
          ),
          Effect.ensuring(Ref.set(runningFiber, Option.none()))
        )

        const fiber = yield* Effect.forkIn(background, activationScope, { startImmediately: true })
        yield* Ref.set(runningFiber, Option.some(fiber))
        yield* Deferred.succeed(gate, undefined)
        yield* Fiber.await(fiber)
      })), Deferred.await(cancelSignal))
    })

    const cancel = Effect.fn("ExecutionEntity.cancel")(function* () {
      yield* store.cancel(executionId).pipe(
        Effect.mapError((cause) => executionError(executionId, "cancel", cause))
      )
      yield* Deferred.succeed(cancelSignal, undefined)
      const fiber = yield* Ref.getAndSet(runningFiber, Option.none())
      if (Option.isSome(fiber)) yield* Fiber.interrupt(fiber.value)

      const execution = yield* store.get(executionId).pipe(
        Effect.mapError((cause) => executionError(executionId, "cancel", cause))
      )
      if (Option.isNone(execution)) {
        return yield* Effect.fail(new Executions.Error({
          executionId,
          operation: "cancel",
          message: "Execution does not exist"
        }))
      }
      return execution.value
    })

    return ExecutionProtocol.entity.of({
      Start: (request) => start(request.payload),
      Cancel: cancel
    })
  })

  return ExecutionProtocol.entity.toLayer(handlers, {
    concurrency: "unbounded",
    mailboxCapacity: 32,
    maxIdleTime: options.entityMaxIdleTime ?? "250 millis"
  })
}

export const clientLayer: Layer.Layer<
  Executions.Service,
  never,
  Crypto.Crypto | ExecutionStore.Service | Sharding.Sharding
> = Layer.effect(
  Executions.Service,
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto
    const store = yield* ExecutionStore.Service
    const makeClient = yield* ExecutionProtocol.entity.client

    const submit: Executions.Interface["submit"] = Effect.fn("Executions.submit")(function* (request) {
      const uuid = yield* crypto.randomUUIDv7.pipe(
        Effect.mapError((cause) => executionError("unassigned", "submit", cause))
      )
      const executionId = `exec-${uuid}`
      const execution = yield* store.create(executionId, request).pipe(
        Effect.mapError((cause) => executionError(executionId, "submit", cause))
      )
      yield* makeClient(executionId).Start(request, { discard: true }).pipe(
        Effect.mapError((cause) => executionError(executionId, "submit", cause))
      )
      return execution
    })

    const get: Executions.Interface["get"] = Effect.fn("Executions.get")(function* (executionId) {
      return yield* store.get(executionId).pipe(
        Effect.mapError((cause) => executionError(executionId, "get", cause))
      )
    })

    const awaitExecution: Executions.Interface["await"] = Effect.fn("Executions.await")(
      function* (executionId) {
        const result = yield* get(executionId).pipe(
          Effect.repeat({
            until: (execution) => Option.isSome(execution) && Execution.isTerminal(execution.value),
            schedule: Schedule.spaced("25 millis")
          })
        )
        if (Option.isNone(result)) {
          return yield* Effect.fail(new Executions.Error({
            executionId,
            operation: "await",
            message: "Execution disappeared"
          }))
        }
        return result.value
      }
    )

    const cancel: Executions.Interface["cancel"] = Effect.fn("Executions.cancel")(function* (executionId) {
      const changed = yield* store.cancel(executionId).pipe(
        Effect.mapError((cause) => executionError(executionId, "cancel", cause))
      )
      if (!changed) return false

      yield* makeClient(executionId).Cancel().pipe(
        Effect.mapError((cause) => executionError(executionId, "cancel", cause))
      )
      return true
    })

    return Executions.Service.of({ submit, get, await: awaitExecution, cancel })
  })
)

export const entity = ExecutionProtocol.entity
