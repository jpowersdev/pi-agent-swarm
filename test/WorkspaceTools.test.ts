import * as it from "@effect/vitest"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Option from "effect/Option"

import type * as Execution from "../src/Execution.js"
import type * as Executions from "../src/Executions.js"
import * as WorkspaceTools from "../src/WorkspaceTools.js"

const queued = (executionId: string, commit: string): Execution.Record => ({
  executionId,
  commit,
  action: "test",
  state: "queued",
  submittedAt: 0,
  runnerAddress: null,
  startedAt: null,
  finishedAt: null,
  exitCode: null,
  output: null,
  durationMillis: null
})

it.effect("maps a cluster execution result to the semantic test result", () =>
  Effect.gen(function* () {
    const execution = queued("execution-1", "commit-1")
    const executions: Executions.Interface = {
      submit: () => Effect.succeed(execution),
      get: () => Effect.succeed(Option.some(execution)),
      await: () => Effect.succeed({
        ...execution,
        state: "succeeded",
        runnerAddress: "runner-a:34431",
        exitCode: 0,
        output: "one test passed",
        durationMillis: 12
      }),
      cancel: () => Effect.succeed(false)
    }

    const result = yield* WorkspaceTools.clusterTestExecutor(executions).test("commit-1")

    it.expect(result).toEqual({
      commit: "commit-1",
      passed: true,
      exitCode: 0,
      output: "one test passed",
      durationMillis: 12
    })
  }))

it.effect("cancels the execution when the semantic test is interrupted", () =>
  Effect.gen(function* () {
    const execution = queued("execution-2", "commit-2")
    const awaiting = yield* Deferred.make<void>()
    const cancelled = yield* Deferred.make<string>()
    const executions: Executions.Interface = {
      submit: () => Effect.succeed(execution),
      get: () => Effect.succeed(Option.some(execution)),
      await: () => Deferred.succeed(awaiting, undefined).pipe(Effect.andThen(Effect.never)),
      cancel: (executionId) => Deferred.succeed(cancelled, executionId).pipe(Effect.as(true))
    }

    const fiber = yield* Effect.forkScoped(WorkspaceTools.clusterTestExecutor(executions).test("commit-2"))
    yield* Deferred.await(awaiting)
    yield* Fiber.interrupt(fiber)

    it.expect(yield* Deferred.await(cancelled)).toBe("execution-2")
  }).pipe(Effect.scoped))
