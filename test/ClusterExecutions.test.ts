import * as it from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Queue from "effect/Queue"
import * as Schedule from "effect/Schedule"
import * as TestRunner from "effect/unstable/cluster/TestRunner"

import * as ClusterExecutions from "../src/ClusterExecutions.js"
import type * as Execution from "../src/Execution.js"
import * as ExecutionBackend from "../src/ExecutionBackend.js"
import * as ExecutionCapacity from "../src/ExecutionCapacity.js"
import * as ExecutionStore from "../src/ExecutionStore.js"
import * as Executions from "../src/Executions.js"

it.effect("runs and cancels Firecracker-shaped work through cluster entities", () =>
  Effect.gen(function* () {
    const started = yield* Queue.unbounded<Execution.Record>()
    const releases = yield* Queue.unbounded<void>()
    const interrupted = yield* Queue.unbounded<string>()

    const BackendLive = Layer.succeed(
      ExecutionBackend.Service,
      ExecutionBackend.Service.of({
        execute: Effect.fn("ExecutionBackend.Test.execute")(function* (execution) {
          yield* Queue.offer(started, execution)
          yield* Queue.take(releases).pipe(
            Effect.onInterrupt(() => Queue.offer(interrupted, execution.executionId))
          )
          return {
            passed: true,
            exitCode: 0,
            output: `completed ${execution.executionId}`,
            durationMillis: 1
          }
        })
      })
    )
    const CapacityLive = ExecutionCapacity.layer(1)
    const StoreLive = ExecutionStore.layerMemory
    const ClusterLive = TestRunner.layer
    const RunnerLive = ClusterExecutions.runnerLayer({ entityMaxIdleTime: "50 millis" }).pipe(
      Layer.provide([BackendLive, CapacityLive, StoreLive, ClusterLive])
    )
    const ClientLive = ClusterExecutions.clientLayer.pipe(
      Layer.provide([StoreLive, ClusterLive, NodeServices.layer]),
      Layer.provide(RunnerLive)
    )

    const program = Effect.gen(function* () {
      const executions = yield* Executions.Service

      const successful = yield* executions.submit({ commit: "commit-success", action: "test" })
      const waiting = yield* executions.submit({ commit: "commit-waiting", action: "test" })
      const runningSuccessful = yield* Queue.take(started)
      it.expect(runningSuccessful.executionId).toBe(successful.executionId)
      it.expect(runningSuccessful.runnerAddress).not.toBeNull()
      yield* Effect.yieldNow
      it.expect(Option.isNone(yield* Queue.poll(started))).toBe(true)

      yield* Queue.offer(releases, undefined)
      const storedSuccessful = yield* executions.get(successful.executionId).pipe(
        Effect.tap(() => Effect.yieldNow),
        Effect.repeat({
          until: (execution) => Option.isSome(execution) && execution.value.state === "succeeded",
          schedule: Schedule.recurs(10_000)
        })
      )
      it.expect(Option.getOrThrow(storedSuccessful).state).toBe("succeeded")
      it.expect((yield* executions.await(successful.executionId)).output).toContain("completed")

      const runningWaiting = yield* Queue.take(started)
      it.expect(runningWaiting.executionId).toBe(waiting.executionId)
      yield* Queue.offer(releases, undefined)
      yield* executions.get(waiting.executionId).pipe(
        Effect.tap(() => Effect.yieldNow),
        Effect.repeat({
          until: (execution) => Option.isSome(execution) && execution.value.state === "succeeded",
          schedule: Schedule.recurs(10_000)
        })
      )
      const waitingResult = yield* executions.await(waiting.executionId)
      it.expect(waitingResult.state).toBe("succeeded")

      const cancelled = yield* executions.submit({ commit: "commit-cancel", action: "test" })
      yield* Queue.take(started)
      it.expect(yield* executions.cancel(cancelled.executionId)).toBe(true)
      it.expect(yield* Queue.take(interrupted)).toBe(cancelled.executionId)

      const cancelledResult = yield* executions.await(cancelled.executionId)
      it.expect(cancelledResult.state).toBe("cancelled")
    }).pipe(Effect.provide(ClientLive))

    yield* program
  }))
