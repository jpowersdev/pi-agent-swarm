import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { fileURLToPath } from "node:url"

import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schedule from "effect/Schedule"

import * as ClusterExecutionClient from "./ClusterExecutionClient.js"
import * as Execution from "./Execution.js"
import * as Executions from "./Executions.js"
import * as Process from "./Process.js"

const repository = fileURLToPath(new URL("../.data/fixture", import.meta.url)).replace(/\/$/, "")

const program = Effect.gen(function* () {
  const executions = yield* Executions.Service
  const revision = yield* Process.successful("git", ["rev-parse", "HEAD"], { cwd: repository })
  const commit = revision.stdout.trim()

  const submitted = yield* Effect.all(
    Array.from({ length: 6 }, () => executions.submit({ commit, action: "test" })),
    { concurrency: "unbounded" }
  )

  const current = Effect.forEach(submitted, (execution) => executions.get(execution.executionId)).pipe(
    Effect.map((records) => records.flatMap(Option.toArray))
  )

  const saturated = yield* current.pipe(
    Effect.repeat({
      until: (records) =>
        records.filter((execution) => execution.state === "running").length === 2 &&
        records.some((execution) => execution.state === "queued"),
      schedule: Schedule.spaced("10 millis")
    }),
    Effect.timeout("15 seconds")
  )

  yield* Console.log("Cluster capacity reached:")
  yield* Console.log(saturated.map(({ executionId, runnerAddress, state }) => ({
    executionId,
    runnerAddress,
    state
  })))

  const completed = yield* Effect.forEach(
    submitted,
    (execution) => executions.await(execution.executionId),
    { concurrency: "unbounded" }
  ).pipe(Effect.timeout("1 minute"))

  const byRunner = new Map<string, number>()
  for (const execution of completed) {
    const runner = execution.runnerAddress ?? "unknown"
    byRunner.set(runner, (byRunner.get(runner) ?? 0) + 1)
  }
  yield* Console.log("Completed by runner:", Object.fromEntries(byRunner))
  yield* Console.log("Results:", completed.map((execution: Execution.Record) => ({
    executionId: execution.executionId,
    runnerAddress: execution.runnerAddress,
    state: execution.state,
    durationMillis: execution.durationMillis
  })))

  const cancellation = yield* executions.submit({ commit, action: "test" })
  yield* executions.get(cancellation.executionId).pipe(
    Effect.repeat({
      until: (execution) => Option.isSome(execution) && execution.value.state === "running",
      schedule: Schedule.spaced("10 millis")
    }),
    Effect.timeout("15 seconds")
  )
  yield* executions.cancel(cancellation.executionId)
  const cancelled = yield* executions.await(cancellation.executionId)
  yield* Console.log("Scoped cancellation:", {
    executionId: cancelled.executionId,
    runnerAddress: cancelled.runnerAddress,
    state: cancelled.state
  })
}).pipe(
  Effect.provide(ClusterExecutionClient.layer),
  Effect.provide(NodeServices.layer)
)

NodeRuntime.runMain(program)
