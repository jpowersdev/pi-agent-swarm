import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schedule from "effect/Schedule"
import type * as Scope from "effect/Scope"

import * as Execution from "./Execution.js"
import * as ExecutionBackend from "./ExecutionBackend.js"
import * as ExecutionStore from "./ExecutionStore.js"

export interface Config {
  readonly executorId: string
  readonly capacity: number
  readonly leaseMillis: number
  readonly pollInterval: Duration.Input
  readonly heartbeatInterval: Duration.Input
}

export interface Daemon {
  readonly register: Effect.Effect<Execution.Executor, ExecutionStore.Error>
  readonly runOne: Effect.Effect<Option.Option<Execution.Record>, ExecutionStore.Error>
  readonly drain: Effect.Effect<void, ExecutionStore.Error>
  readonly run: Effect.Effect<never, ExecutionStore.Error, Scope.Scope>
}

export const make = Effect.fn("ExecutorDaemon.make")(function* (config: Config) {
  const store = yield* ExecutionStore.Service
  const backend = yield* ExecutionBackend.Service

  const register = store.registerExecutor(config.executorId, config.capacity)

  const runOne: Daemon["runOne"] = Effect.gen(function* () {
    const lease = yield* store.leaseNext(config.executorId, config.leaseMillis)
    if (Option.isNone(lease)) return Option.none()

    const { execution, token } = lease.value
    yield* store.markRunning(execution.executionId, token)

    const outcome = yield* backend.execute(execution).pipe(
      Effect.catch((error) => Effect.succeed({
        passed: false,
        exitCode: 125,
        output: `Executor backend failed: ${String(error.cause)}`,
        durationMillis: 0
      }))
    )

    return Option.some(yield* store.complete(execution.executionId, token, outcome))
  }).pipe(Effect.withSpan("ExecutorDaemon.runOne", {
    attributes: { executorId: config.executorId }
  }))

  const heartbeat = store.heartbeat(config.executorId).pipe(
    Effect.tapError((error) => Effect.logError("Executor heartbeat failed", error)),
    Effect.ignore,
    Effect.repeat(Schedule.spaced(config.heartbeatInterval)),
    Effect.asVoid
  )

  const lane = runOne.pipe(
    Effect.tapError((error) => Effect.logError("Executor polling pass failed", error)),
    Effect.ignore,
    Effect.repeat(Schedule.spaced(config.pollInterval)),
    Effect.asVoid
  )

  const run: Daemon["run"] = Effect.gen(function* () {
    yield* register
    yield* heartbeat.pipe(Effect.forkScoped)

    yield* Effect.forEach(
      Array.from({ length: config.capacity }),
      () => lane.pipe(Effect.forkScoped),
      { discard: true }
    )

    return yield* Effect.never
  })

  return {
    register,
    runOne,
    drain: store.drain(config.executorId),
    run
  } satisfies Daemon
})
