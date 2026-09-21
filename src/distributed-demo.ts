import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import { fileURLToPath } from "node:url"

import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Schedule from "effect/Schedule"

import * as Execution from "./Execution.js"
import * as ExecutionStore from "./ExecutionStore.js"
import * as Process from "./Process.js"
import * as RemoteExecutionStore from "./RemoteExecutionStore.js"

const repository = fileURLToPath(new URL("../../pi-agent-swarm-fixture", import.meta.url)).replace(/\/$/, "")

const isTerminal = (execution: Execution.Record) =>
  execution.state === "succeeded" ||
  execution.state === "failed" ||
  execution.state === "cancelled"

const program = Effect.gen(function* () {
  const store = yield* ExecutionStore.Service
  const revision = yield* Process.successful("git", ["rev-parse", "HEAD"], { cwd: repository })
  const commit = revision.stdout.trim()

  const submitted = yield* Effect.all([
    store.submit({ commit, action: "test" }),
    store.submit({ commit, action: "test" }),
    store.submit({ commit, action: "test" })
  ])
  const executionIds = new Set(submitted.map((execution) => execution.executionId))
  const currentExecutions = store.list().pipe(
    Effect.map((executions) => executions.filter((execution) => executionIds.has(execution.executionId)))
  )

  const saturated = yield* currentExecutions.pipe(
    Effect.repeat({
      until: (executions) =>
        executions.filter((execution) => execution.state === "running").length === 2 &&
        executions.filter((execution) => execution.state === "queued").length === 1,
      schedule: Schedule.spaced("10 millis")
    })
  )
  yield* Console.log("Two remote executors saturated; third execution remains queued:")
  yield* Console.log(saturated.map(({ executionId, executorId, state }) => ({
    executionId,
    executorId,
    state
  })))
  yield* Console.log("Fleet capacity:", yield* store.fleet())

  const completed = yield* currentExecutions.pipe(
    Effect.repeat({
      until: (executions) => executions.length === 3 && executions.every(isTerminal),
      schedule: Schedule.spaced("25 millis")
    })
  )
  yield* Console.log("All remote executions completed:")
  yield* Console.log(completed.map(({ durationMillis, executionId, executorId, state }) => ({
    executionId,
    executorId,
    state,
    durationMillis
  })))
}).pipe(Effect.provide(RemoteExecutionStore.layer("http://127.0.0.1:8787")))

NodeRuntime.runMain(program)
