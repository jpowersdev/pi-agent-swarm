import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"

import * as Execution from "./Execution.js"
import * as ExecutionStore from "./ExecutionStore.js"

const Row = Schema.Struct({
  execution_id: Schema.String,
  commit_hash: Schema.String,
  action: Execution.Action,
  state: Execution.State,
  submitted_at: Schema.Number,
  runner_address: Schema.NullOr(Schema.String),
  started_at: Schema.NullOr(Schema.Number),
  finished_at: Schema.NullOr(Schema.Number),
  exit_code: Schema.NullOr(Schema.Number),
  output: Schema.NullOr(Schema.String),
  duration_millis: Schema.NullOr(Schema.Number)
})

interface Row extends Schema.Schema.Type<typeof Row> {}

const toExecution = (row: Row): Execution.Record => ({
  executionId: row.execution_id,
  commit: row.commit_hash,
  action: row.action,
  state: row.state,
  submittedAt: row.submitted_at,
  runnerAddress: row.runner_address,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  exitCode: row.exit_code,
  output: row.output,
  durationMillis: row.duration_millis
})

const failure = (operation: ExecutionStore.Error["operation"], cause: unknown) =>
  new ExecutionStore.Error({ operation, cause })

const decode = (operation: ExecutionStore.Error["operation"], row: unknown) =>
  Schema.decodeUnknownEffect(Row)(row).pipe(
    Effect.map(toExecution),
    Effect.mapError((cause) => failure(operation, cause))
  )

export const layer: Layer.Layer<ExecutionStore.Service, ExecutionStore.Error, SqlClient.SqlClient> =
  Layer.effect(
    ExecutionStore.Service,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      yield* sql`
        CREATE TABLE IF NOT EXISTS swarm_executions (
          execution_id TEXT PRIMARY KEY,
          commit_hash TEXT NOT NULL,
          action TEXT NOT NULL,
          state TEXT NOT NULL,
          submitted_at DOUBLE PRECISION NOT NULL,
          runner_address TEXT,
          started_at DOUBLE PRECISION,
          finished_at DOUBLE PRECISION,
          exit_code INTEGER,
          output TEXT,
          duration_millis DOUBLE PRECISION
        )
      `.pipe(Effect.mapError((cause) => failure("open", cause)))

      yield* sql`
        CREATE INDEX IF NOT EXISTS swarm_executions_state
        ON swarm_executions(state, submitted_at)
      `.pipe(Effect.mapError((cause) => failure("open", cause)))

      const get: ExecutionStore.Interface["get"] = Effect.fn("ExecutionStore.Sql.get")(
        function* (executionId) {
          const rows = yield* sql`
            SELECT * FROM swarm_executions WHERE execution_id = ${executionId}
          `.pipe(Effect.mapError((cause) => failure("get", cause)))
          if (rows.length === 0) return Option.none()
          return Option.some(yield* decode("get", rows[0]))
        }
      )

      const create: ExecutionStore.Interface["create"] = Effect.fn("ExecutionStore.Sql.create")(
        function* (executionId, request) {
          const submittedAt = yield* Clock.currentTimeMillis
          const execution = yield* Effect.gen(function* () {
            yield* sql`
              INSERT INTO swarm_executions (
                execution_id, commit_hash, action, state, submitted_at
              ) VALUES (
                ${executionId}, ${request.commit}, ${request.action}, 'queued', ${submittedAt}
              )
              ON CONFLICT (execution_id) DO NOTHING
            `
            const rows = yield* sql`
              SELECT * FROM swarm_executions WHERE execution_id = ${executionId}
            `
            return yield* decode("create", rows[0])
          }).pipe(
            sql.withTransaction,
            Effect.mapError((cause) => cause instanceof ExecutionStore.Error
              ? cause
              : failure("create", cause))
          )

          if (execution.commit !== request.commit || execution.action !== request.action) {
            return yield* Effect.fail(failure(
              "create",
              new globalThis.Error(`Execution id ${executionId} was already used for a different request`)
            ))
          }
          return execution
        }
      )

      const list: ExecutionStore.Interface["list"] = Effect.fn("ExecutionStore.Sql.list")(function* () {
        const rows = yield* sql`
          SELECT * FROM swarm_executions ORDER BY submitted_at, execution_id
        `.pipe(Effect.mapError((cause) => failure("list", cause)))
        return yield* Effect.forEach(rows, (row) => decode("list", row))
      })

      const start: ExecutionStore.Interface["start"] = Effect.fn("ExecutionStore.Sql.start")(
        function* (executionId, runnerAddress) {
          const startedAt = yield* Clock.currentTimeMillis
          const rows = yield* sql`
            UPDATE swarm_executions
            SET state = 'running', runner_address = ${runnerAddress}, started_at = ${startedAt}
            WHERE execution_id = ${executionId} AND state = 'queued'
            RETURNING *
          `.pipe(Effect.mapError((cause) => failure("start", cause)))
          if (rows.length === 0) return Option.none()
          return Option.some(yield* decode("start", rows[0]))
        }
      )

      const complete: ExecutionStore.Interface["complete"] = Effect.fn("ExecutionStore.Sql.complete")(
        function* (executionId, outcome) {
          const finishedAt = yield* Clock.currentTimeMillis
          const state: Execution.State = outcome.passed ? "succeeded" : "failed"
          const rows = yield* sql`
            UPDATE swarm_executions
            SET
              state = ${state},
              finished_at = ${finishedAt},
              exit_code = ${outcome.exitCode},
              output = ${outcome.output},
              duration_millis = ${outcome.durationMillis}
            WHERE execution_id = ${executionId} AND state = 'running'
            RETURNING *
          `.pipe(Effect.mapError((cause) => failure("complete", cause)))
          if (rows.length > 0) return yield* decode("complete", rows[0])

          const execution = yield* get(executionId)
          if (Option.isNone(execution)) {
            return yield* Effect.fail(failure(
              "complete",
              new globalThis.Error(`Unknown execution: ${executionId}`)
            ))
          }
          return execution.value
        }
      )

      const cancel: ExecutionStore.Interface["cancel"] = Effect.fn("ExecutionStore.Sql.cancel")(
        function* (executionId) {
          const finishedAt = yield* Clock.currentTimeMillis
          const rows = yield* sql`
            UPDATE swarm_executions
            SET state = 'cancelled', finished_at = ${finishedAt}, output = 'Cancelled'
            WHERE execution_id = ${executionId} AND state IN ('queued', 'running')
            RETURNING execution_id
          `.pipe(Effect.mapError((cause) => failure("cancel", cause)))
          return rows.length === 1
        }
      )

      return ExecutionStore.Service.of({ create, get, list, start, complete, cancel })
    })
  )
