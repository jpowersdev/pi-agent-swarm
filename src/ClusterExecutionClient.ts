import * as NodeClusterSocket from "@effect/platform-node/NodeClusterSocket"
import * as PgClient from "@effect/sql-pg/PgClient"

import * as Layer from "effect/Layer"
import * as Option from "effect/Option"

import * as ClusterExecutions from "./ClusterExecutions.js"
import * as ExecutionIds from "./ExecutionIds.js"
import * as ExecutionIdsSql from "./ExecutionIdsSql.js"
import * as ExecutionStoreSql from "./ExecutionStoreSql.js"

export const sqlLayer = PgClient.layer({
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

export const layer = ClusterExecutions.clientLayer.pipe(
  Layer.provide([ExecutionIdsLive, ExecutionStoreSql.layer, ShardingLive]),
  Layer.provide(sqlLayer)
)
