import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Sharding from "effect/unstable/cluster/Sharding"
import * as SqlClient from "effect/unstable/sql/SqlClient"

import * as ExecutionIds from "./ExecutionIds.js"

const CursorRow = Schema.Struct({ value: Schema.Number })

export const layer: Layer.Layer<
  ExecutionIds.Service,
  ExecutionIds.Error,
  Sharding.Sharding | SqlClient.SqlClient
> = Layer.effect(
  ExecutionIds.Service,
  Effect.gen(function* () {
    const sharding = yield* Sharding.Sharding
    const sql = yield* SqlClient.SqlClient

    yield* sql`
      CREATE SEQUENCE IF NOT EXISTS swarm_execution_placement_cursor
      MINVALUE 0
      START 0
    `.pipe(
      Effect.mapError((cause) => new ExecutionIds.Error({ operation: "initialize", cause }))
    )

    const nextCursor = Effect.gen(function* () {
      const rows = yield* sql`
        SELECT nextval('swarm_execution_placement_cursor')::double precision AS value
      `.pipe(
        Effect.mapError((cause) => new ExecutionIds.Error({ operation: "next", cause }))
      )
      const row = yield* Schema.decodeUnknownEffect(CursorRow)(rows[0]).pipe(
        Effect.mapError((cause) => new ExecutionIds.Error({ operation: "next", cause }))
      )
      return row.value
    })

    return ExecutionIds.Service.of(ExecutionIds.make(sharding, nextCursor))
  })
)
