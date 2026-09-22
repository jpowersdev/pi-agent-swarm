import * as NodeClusterSocket from "@effect/platform-node/NodeClusterSocket"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as PgClient from "@effect/sql-pg/PgClient"
import { fileURLToPath } from "node:url"

import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as RunnerAddress from "effect/unstable/cluster/RunnerAddress"

import * as ClusterExecutions from "./ClusterExecutions.js"
import * as ExecutionBackend from "./ExecutionBackend.js"
import * as ExecutionCapacity from "./ExecutionCapacity.js"
import * as ExecutionStoreSql from "./ExecutionStoreSql.js"

const projectRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "")
const repository = fileURLToPath(new URL("../../pi-agent-swarm-fixture", import.meta.url)).replace(/\/$/, "")
const SqlLive = PgClient.layer({
  host: "127.0.0.1",
  port: 55432,
  database: "postgres",
  username: "postgres",
  maxConnections: 10
})
const BackendLive = ExecutionBackend.firecrackerLayer(projectRoot, repository)

const RunnerLive = Layer.unwrap(
  Config.all({
    host: Config.NonEmptyString("SWARM_RUNNER_HOST").pipe(Config.withDefault("127.0.0.1")),
    port: Config.Int("SWARM_RUNNER_PORT"),
    capacity: Config.Int("SWARM_RUNNER_CAPACITY").pipe(Config.withDefault(1))
  }).pipe(
    Config.map(({ capacity, host, port }) => {
      const ShardingLive = NodeClusterSocket.layer({
        storage: "sql",
        serialization: "ndjson",
        shardingConfig: {
          runnerAddress: Option.some(RunnerAddress.make(host, port)),
          maxResidentEntities: Math.max(64, capacity * 16),
          entityMaxIdleTime: "250 millis",
          shardLockRefreshInterval: "100 millis",
          shardLockExpiration: "2 seconds",
          refreshAssignmentsInterval: "100 millis",
          entityMessagePollInterval: "10 millis",
          entityReplyPollInterval: "25 millis",
          runnerHealthCheckInterval: "250 millis"
        }
      })

      return ClusterExecutions.runnerLayer({ entityMaxIdleTime: "250 millis" }).pipe(
        Layer.provide([
          BackendLive,
          ExecutionCapacity.layer(capacity),
          ExecutionStoreSql.layer,
          ShardingLive
        ]),
        Layer.provide(SqlLive)
      )
    })
  )
)

Layer.launch(RunnerLive).pipe(
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain
)
