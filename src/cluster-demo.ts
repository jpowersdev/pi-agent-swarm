import * as NodeClusterSocket from "@effect/platform-node/NodeClusterSocket"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as PgClient from "@effect/sql-pg/PgClient"
import { fileURLToPath } from "node:url"

import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schedule from "effect/Schedule"

import * as ClusterExecutions from "./ClusterExecutions.js"
import * as Execution from "./Execution.js"
import * as ExecutionIds from "./ExecutionIds.js"
import * as ExecutionIdsSql from "./ExecutionIdsSql.js"
import * as ExecutionStoreSql from "./ExecutionStoreSql.js"
import * as Executions from "./Executions.js"
import * as Process from "./Process.js"

const repository = fileURLToPath(new URL("../../pi-agent-swarm-fixture", import.meta.url)).replace(/\/$/, "")
const SqlLive = PgClient.layer({
  host: "127.0.0.1",
  port: 55432,
  database: "postgres",
  username: "postgres",
  maxConnections: 10
})
const ShardingLive = NodeClusterSocket.layer({
  clientOnly: true,
  storage: "sql",
  serialization: "ndjson",
  shardingConfig: {
    runnerAddress: Option.none(),
    shardsPerGroup: ExecutionIds.shardsPerGroup,
    shardLockRefreshInterval: "100 millis",
    shardLockExpiration: "2 seconds",
    refreshAssignmentsInterval: "100 millis",
    entityMessagePollInterval: "10 millis",
    entityReplyPollInterval: "25 millis"
  }
})

const ExecutionIdsLive = ExecutionIdsSql.layer.pipe(Layer.provide(ShardingLive))

const ClientLive = ClusterExecutions.clientLayer.pipe(
  Layer.provide([ExecutionIdsLive, ExecutionStoreSql.layer, ShardingLive]),
  Layer.provide(SqlLive)
)

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
  Effect.provide(ClientLive),
  Effect.provide(NodeServices.layer)
)

NodeRuntime.runMain(program)
