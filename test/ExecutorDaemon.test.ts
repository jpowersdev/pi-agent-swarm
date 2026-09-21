import * as it from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Queue from "effect/Queue"
import * as Ref from "effect/Ref"

import type * as Execution from "../src/Execution.js"
import * as ExecutionBackend from "../src/ExecutionBackend.js"
import * as ExecutionStore from "../src/ExecutionStore.js"
import * as ExecutorDaemon from "../src/ExecutorDaemon.js"

it.effect("leases work across capacity-limited executor daemons", () =>
  Effect.gen(function* () {
    const started = yield* Queue.unbounded<Execution.Record>()
    const releases = yield* Queue.unbounded<void>()
    const active = yield* Ref.make(0)
    const maximumActive = yield* Ref.make(0)

    const backendLayer = Layer.succeed(
      ExecutionBackend.Service,
      ExecutionBackend.Service.of({
        execute: Effect.fn("ExecutionBackend.Test.execute")(function* (execution) {
          const current = yield* Ref.updateAndGet(active, (count) => count + 1)
          yield* Ref.update(maximumActive, (maximum) => Math.max(maximum, current))
          yield* Queue.offer(started, execution)
          yield* Queue.take(releases)
          yield* Ref.update(active, (count) => count - 1)

          return {
            passed: true,
            exitCode: 0,
            output: `completed ${execution.executionId}`,
            durationMillis: 1
          }
        })
      })
    )

    const program = Effect.gen(function* () {
      const store = yield* ExecutionStore.Service
      const executorA = yield* ExecutorDaemon.make({
        executorId: "executor-a",
        capacity: 1,
        leaseMillis: 30_000,
        pollInterval: "10 millis",
        heartbeatInterval: "1 second"
      })
      const executorB = yield* ExecutorDaemon.make({
        executorId: "executor-b",
        capacity: 1,
        leaseMillis: 30_000,
        pollInterval: "10 millis",
        heartbeatInterval: "1 second"
      })

      yield* executorA.register
      yield* executorB.register

      yield* store.submit({ commit: "commit-1", action: "test" })
      yield* store.submit({ commit: "commit-2", action: "test" })
      yield* store.submit({ commit: "commit-3", action: "test" })

      const first = yield* executorA.runOne.pipe(Effect.forkScoped)
      const second = yield* executorB.runOne.pipe(Effect.forkScoped)

      yield* Queue.take(started)
      yield* Queue.take(started)

      const whileFull = yield* executorA.runOne
      it.expect(Option.isNone(whileFull)).toBe(true)

      const inFlight = yield* store.list()
      it.expect(inFlight.filter((execution) => execution.state === "running")).toHaveLength(2)
      it.expect(inFlight.filter((execution) => execution.state === "queued")).toHaveLength(1)

      const saturatedFleet = yield* store.fleet()
      it.expect(saturatedFleet.queued).toBe(1)
      it.expect(saturatedFleet.running).toBe(2)
      it.expect(saturatedFleet.executors.map((executor) => executor.available)).toEqual([0, 0])

      yield* Queue.offer(releases, undefined)
      yield* Queue.offer(releases, undefined)
      yield* Fiber.join(first)
      yield* Fiber.join(second)

      const third = yield* executorA.runOne.pipe(Effect.forkScoped)
      yield* Queue.take(started)
      yield* Queue.offer(releases, undefined)
      yield* Fiber.join(third)

      yield* executorB.drain
      yield* store.submit({ commit: "commit-4", action: "test" })

      const drainingLease = yield* executorB.runOne
      it.expect(Option.isNone(drainingLease)).toBe(true)

      const drainingFleet = yield* store.fleet()
      it.expect(drainingFleet.executors.find((executor) => executor.executorId === "executor-b")).toMatchObject({
        state: "draining",
        available: 0
      })

      const fourth = yield* executorA.runOne.pipe(Effect.forkScoped)
      yield* Queue.take(started)
      yield* Queue.offer(releases, undefined)
      yield* Fiber.join(fourth)

      const completed = yield* store.list()
      it.expect(completed.map((execution) => execution.state)).toEqual([
        "succeeded",
        "succeeded",
        "succeeded",
        "succeeded"
      ])
      it.expect(yield* Ref.get(maximumActive)).toBe(2)
    }).pipe(
      Effect.scoped,
      Effect.provide([
        ExecutionStore.layer(":memory:").pipe(
          Layer.provide(NodeServices.layer)
        ),
        backendLayer
      ])
    )

    yield* program
  }))
