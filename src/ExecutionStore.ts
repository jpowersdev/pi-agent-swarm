import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { DatabaseSync, type SQLOutputValue } from "node:sqlite"

import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

import * as Execution from "./Execution.js"

export class Error extends Schema.TaggedError<Error>()("ExecutionStoreError", {
  operation: Schema.Literals([
    "cancel",
    "complete",
    "drain",
    "fleet",
    "get",
    "heartbeat",
    "lease",
    "list",
    "markRunning",
    "open",
    "register",
    "submit"
  ]),
  cause: Schema.Defect()
}) {}

export interface Interface {
  readonly submit: (request: Execution.Request) => Effect.Effect<Execution.Record, Error>
  readonly get: (executionId: string) => Effect.Effect<Option.Option<Execution.Record>, Error>
  readonly list: () => Effect.Effect<ReadonlyArray<Execution.Record>, Error>
  readonly fleet: () => Effect.Effect<Execution.Fleet, Error>
  readonly cancel: (executionId: string) => Effect.Effect<boolean, Error>
  readonly registerExecutor: (executorId: string, capacity: number) => Effect.Effect<Execution.Executor, Error>
  readonly heartbeat: (executorId: string) => Effect.Effect<void, Error>
  readonly drain: (executorId: string) => Effect.Effect<void, Error>
  readonly leaseNext: (executorId: string, leaseMillis: number) => Effect.Effect<Option.Option<Execution.Lease>, Error>
  readonly markRunning: (executionId: string, token: string) => Effect.Effect<void, Error>
  readonly complete: (
    executionId: string,
    token: string,
    outcome: Execution.Outcome
  ) => Effect.Effect<Execution.Record, Error>
}

export class Service extends Context.Service<Service, Interface>()("pi-agent-swarm/ExecutionStore") {}

const ExecutionRow = Schema.Struct({
  execution_id: Schema.String,
  commit_hash: Schema.String,
  action: Execution.Action,
  state: Execution.State,
  submitted_at: Schema.Number,
  executor_id: Schema.NullOr(Schema.String),
  lease_expires_at: Schema.NullOr(Schema.Number),
  started_at: Schema.NullOr(Schema.Number),
  finished_at: Schema.NullOr(Schema.Number),
  exit_code: Schema.NullOr(Schema.Number),
  output: Schema.NullOr(Schema.String),
  duration_millis: Schema.NullOr(Schema.Number)
})

interface ExecutionRow extends Schema.Schema.Type<typeof ExecutionRow> {}

const ExecutorRow = Schema.Struct({
  executor_id: Schema.String,
  capacity: Schema.Number,
  state: Execution.ExecutorState,
  heartbeat_at: Schema.Number
})

interface ExecutorRow extends Schema.Schema.Type<typeof ExecutorRow> {}

const ExecutorCapacityRow = Schema.Struct({
  ...ExecutorRow.fields,
  active: Schema.Number
})

interface ExecutorCapacityRow extends Schema.Schema.Type<typeof ExecutorCapacityRow> {}

const FleetCountsRow = Schema.Struct({
  queued: Schema.Number,
  leased: Schema.Number,
  running: Schema.Number
})

const toExecution = (row: ExecutionRow): Execution.Record => ({
  executionId: row.execution_id,
  commit: row.commit_hash,
  action: row.action,
  state: row.state,
  submittedAt: row.submitted_at,
  executorId: row.executor_id,
  leaseExpiresAt: row.lease_expires_at,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  exitCode: row.exit_code,
  output: row.output,
  durationMillis: row.duration_millis
})

const toExecutor = (row: ExecutorRow): Execution.Executor => ({
  executorId: row.executor_id,
  capacity: row.capacity,
  state: row.state,
  heartbeatAt: row.heartbeat_at
})

const fail = (operation: Error["operation"], cause: unknown) => new Error({ operation, cause })

const initialize = (database: DatabaseSync) => {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS executions (
      execution_id TEXT PRIMARY KEY,
      commit_hash TEXT NOT NULL,
      action TEXT NOT NULL,
      state TEXT NOT NULL,
      submitted_at INTEGER NOT NULL,
      executor_id TEXT,
      lease_token TEXT,
      lease_expires_at INTEGER,
      started_at INTEGER,
      finished_at INTEGER,
      exit_code INTEGER,
      output TEXT,
      duration_millis INTEGER
    );

    CREATE INDEX IF NOT EXISTS executions_queue
      ON executions(state, submitted_at);

    CREATE TABLE IF NOT EXISTS executors (
      executor_id TEXT PRIMARY KEY,
      capacity INTEGER NOT NULL,
      state TEXT NOT NULL,
      heartbeat_at INTEGER NOT NULL
    );
  `)
}

const transaction = <A>(database: DatabaseSync, evaluate: () => A): A => {
  database.exec("BEGIN IMMEDIATE")
  try {
    const result = evaluate()
    database.exec("COMMIT")
    return result
  } catch (cause) {
    database.exec("ROLLBACK")
    throw cause
  }
}

const decodeExecution = (operation: Error["operation"], row: unknown) =>
  Schema.decodeUnknownEffect(ExecutionRow)(row).pipe(
    Effect.map(toExecution),
    Effect.mapError((cause) => fail(operation, cause))
  )

const decodeExecutor = (row: unknown) =>
  Schema.decodeUnknownEffect(ExecutorRow)(row).pipe(
    Effect.map(toExecutor),
    Effect.mapError((cause) => fail("register", cause))
  )

const randomId = (
  crypto: Crypto.Crypto,
  operation: Error["operation"],
  prefix: string
) => crypto.randomUUIDv7.pipe(
  Effect.map((id) => `${prefix}-${id}`),
  Effect.mapError((cause) => fail(operation, cause))
)

const make = (database: DatabaseSync): Effect.Effect<Interface, never, Crypto.Crypto> =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto
    const submit: Interface["submit"] = Effect.fn("ExecutionStore.submit")(function* (request) {
      const executionId = yield* randomId(crypto, "submit", "exec")
      const submittedAt = yield* Clock.currentTimeMillis

      yield* Effect.try({
        try: () => database.prepare(`
          INSERT INTO executions (
            execution_id, commit_hash, action, state, submitted_at
          ) VALUES (?, ?, ?, 'queued', ?)
        `).run(executionId, request.commit, request.action, submittedAt),
        catch: (cause) => fail("submit", cause)
      })

      return {
        executionId,
        commit: request.commit,
        action: request.action,
        state: "queued",
        submittedAt,
        executorId: null,
        leaseExpiresAt: null,
        startedAt: null,
        finishedAt: null,
        exitCode: null,
        output: null,
        durationMillis: null
      }
    })

    const get: Interface["get"] = Effect.fn("ExecutionStore.get")(function* (executionId) {
      const row = yield* Effect.try({
        try: () => database.prepare("SELECT * FROM executions WHERE execution_id = ?").get(executionId),
        catch: (cause) => fail("get", cause)
      })

      if (row === undefined) return Option.none()
      return Option.some(yield* decodeExecution("get", row))
    })

    const list: Interface["list"] = Effect.fn("ExecutionStore.list")(function* () {
      const rows = yield* Effect.try({
        try: () => database.prepare("SELECT * FROM executions ORDER BY submitted_at, execution_id").all(),
        catch: (cause) => fail("list", cause)
      })
      return yield* Effect.forEach(rows, (row) => decodeExecution("list", row))
    })

    const fleet: Interface["fleet"] = Effect.fn("ExecutionStore.fleet")(function* () {
      const result = yield* Effect.try({
        try: () => ({
          counts: database.prepare(`
            SELECT
              COUNT(*) FILTER (WHERE state = 'queued') AS queued,
              COUNT(*) FILTER (WHERE state = 'leased') AS leased,
              COUNT(*) FILTER (WHERE state = 'running') AS running
            FROM executions
          `).get(),
          executors: database.prepare(`
            SELECT
              executor.executor_id,
              executor.capacity,
              executor.state,
              executor.heartbeat_at,
              COUNT(execution.execution_id) AS active
            FROM executors AS executor
            LEFT JOIN executions AS execution
              ON execution.executor_id = executor.executor_id
              AND execution.state IN ('leased', 'running')
            GROUP BY
              executor.executor_id,
              executor.capacity,
              executor.state,
              executor.heartbeat_at
            ORDER BY executor.executor_id
          `).all()
        }),
        catch: (cause) => fail("fleet", cause)
      })

      const counts = yield* Schema.decodeUnknownEffect(FleetCountsRow)(result.counts).pipe(
        Effect.mapError((cause) => fail("fleet", cause))
      )
      const executors = yield* Effect.forEach(result.executors, (row) =>
        Schema.decodeUnknownEffect(ExecutorCapacityRow)(row).pipe(
          Effect.map((executor) => ({
            ...toExecutor(executor),
            active: executor.active,
            available: executor.state === "ready"
              ? Math.max(0, executor.capacity - executor.active)
              : 0
          })),
          Effect.mapError((cause) => fail("fleet", cause))
        ))

      return { ...counts, executors }
    })

    const cancel: Interface["cancel"] = Effect.fn("ExecutionStore.cancel")(function* (executionId) {
      const now = yield* Clock.currentTimeMillis
      const result = yield* Effect.try({
        try: () => database.prepare(`
          UPDATE executions
          SET state = 'cancelled', finished_at = ?
          WHERE execution_id = ? AND state = 'queued'
        `).run(now, executionId),
        catch: (cause) => fail("cancel", cause)
      })
      return Number(result.changes) === 1
    })

    const registerExecutor: Interface["registerExecutor"] = Effect.fn("ExecutionStore.registerExecutor")(
      function* (executorId, capacity) {
        if (!Number.isInteger(capacity) || capacity < 1) {
          return yield* Effect.fail(fail("register", new globalThis.Error(`Invalid capacity: ${capacity}`)))
        }

        const heartbeatAt = yield* Clock.currentTimeMillis
        const row = yield* Effect.try({
          try: () => {
            database.prepare(`
              INSERT INTO executors (executor_id, capacity, state, heartbeat_at)
              VALUES (?, ?, 'ready', ?)
              ON CONFLICT(executor_id) DO UPDATE SET
                capacity = excluded.capacity,
                state = 'ready',
                heartbeat_at = excluded.heartbeat_at
            `).run(executorId, capacity, heartbeatAt)
            return database.prepare("SELECT * FROM executors WHERE executor_id = ?").get(executorId)
          },
          catch: (cause) => fail("register", cause)
        })

        return yield* decodeExecutor(row)
      }
    )

    const heartbeat: Interface["heartbeat"] = Effect.fn("ExecutionStore.heartbeat")(function* (executorId) {
      const heartbeatAt = yield* Clock.currentTimeMillis
      const result = yield* Effect.try({
        try: () => database.prepare(`
          UPDATE executors SET heartbeat_at = ? WHERE executor_id = ?
        `).run(heartbeatAt, executorId),
        catch: (cause) => fail("heartbeat", cause)
      })
      if (Number(result.changes) !== 1) {
        return yield* Effect.fail(fail("heartbeat", new globalThis.Error(`Unknown executor: ${executorId}`)))
      }
    })

    const drain: Interface["drain"] = Effect.fn("ExecutionStore.drain")(function* (executorId) {
      yield* Effect.try({
        try: () => database.prepare(`
          UPDATE executors SET state = 'draining' WHERE executor_id = ?
        `).run(executorId),
        catch: (cause) => fail("drain", cause)
      })
    })

    const leaseNext: Interface["leaseNext"] = Effect.fn("ExecutionStore.leaseNext")(
      function* (executorId, leaseMillis) {
        const token = yield* randomId(crypto, "lease", "lease")
        const now = yield* Clock.currentTimeMillis
        const leaseExpiresAt = now + leaseMillis

        const row = yield* Effect.try({
          try: () => transaction(database, () => {
            database.prepare(`
              UPDATE executions
              SET state = 'queued', executor_id = NULL, lease_token = NULL, lease_expires_at = NULL
              WHERE state = 'leased' AND lease_expires_at <= ?
            `).run(now)

            const executor = database.prepare(`
              SELECT capacity, state FROM executors WHERE executor_id = ?
            `).get(executorId)
            if (executor === undefined || executor["state"] !== "ready") return undefined

            const capacityValue: SQLOutputValue | undefined = executor["capacity"]
            if (typeof capacityValue !== "number" || capacityValue < 1) return undefined

            const active = database.prepare(`
              SELECT COUNT(*) AS count
              FROM executions
              WHERE executor_id = ? AND state IN ('leased', 'running')
            `).get(executorId)
            const activeValue: SQLOutputValue | undefined = active?.["count"]
            if (typeof activeValue !== "number" || activeValue >= capacityValue) return undefined

            const candidate = database.prepare(`
              SELECT execution_id
              FROM executions
              WHERE state = 'queued'
              ORDER BY submitted_at, execution_id
              LIMIT 1
            `).get()
            const executionId: SQLOutputValue | undefined = candidate?.["execution_id"]
            if (typeof executionId !== "string") return undefined

            const updated = database.prepare(`
              UPDATE executions
              SET state = 'leased', executor_id = ?, lease_token = ?, lease_expires_at = ?
              WHERE execution_id = ? AND state = 'queued'
            `).run(executorId, token, leaseExpiresAt, executionId)
            if (Number(updated.changes) !== 1) return undefined

            return database.prepare("SELECT * FROM executions WHERE execution_id = ?").get(executionId)
          }),
          catch: (cause) => fail("lease", cause)
        })

        if (row === undefined) return Option.none()
        const execution = yield* decodeExecution("lease", row)
        return Option.some({ execution, token })
      }
    )

    const markRunning: Interface["markRunning"] = Effect.fn("ExecutionStore.markRunning")(
      function* (executionId, token) {
        const startedAt = yield* Clock.currentTimeMillis
        const result = yield* Effect.try({
          try: () => database.prepare(`
            UPDATE executions
            SET state = 'running', started_at = ?
            WHERE execution_id = ? AND lease_token = ? AND state = 'leased'
          `).run(startedAt, executionId, token),
          catch: (cause) => fail("markRunning", cause)
        })
        if (Number(result.changes) !== 1) {
          return yield* Effect.fail(
            fail("markRunning", new globalThis.Error(`Invalid lease for execution: ${executionId}`))
          )
        }
      }
    )

    const complete: Interface["complete"] = Effect.fn("ExecutionStore.complete")(
      function* (executionId, token, outcome) {
        const finishedAt = yield* Clock.currentTimeMillis
        const state: Execution.State = outcome.passed ? "succeeded" : "failed"

        const row = yield* Effect.try({
          try: () => transaction(database, () => {
            const result = database.prepare(`
              UPDATE executions
              SET state = ?, finished_at = ?, exit_code = ?, output = ?, duration_millis = ?,
                  lease_expires_at = NULL
              WHERE execution_id = ? AND lease_token = ? AND state = 'running'
            `).run(
              state,
              finishedAt,
              outcome.exitCode,
              outcome.output,
              outcome.durationMillis,
              executionId,
              token
            )
            if (Number(result.changes) !== 1) {
              throw new globalThis.Error(`Invalid running lease for execution: ${executionId}`)
            }
            return database.prepare("SELECT * FROM executions WHERE execution_id = ?").get(executionId)
          }),
          catch: (cause) => fail("complete", cause)
        })

        return yield* decodeExecution("complete", row)
      }
    )

    return Service.of({
      submit,
      get,
      list,
      fleet,
      cancel,
      registerExecutor,
      heartbeat,
      drain,
      leaseNext,
      markRunning,
      complete
    })
  })

export const layer = (path: string): Layer.Layer<Service, Error, Crypto.Crypto> =>
  Layer.effect(
    Service,
    Effect.acquireRelease(
      Effect.try({
        try: () => {
          if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
          const database = new DatabaseSync(path)
          initialize(database)
          return database
        },
        catch: (cause) => fail("open", cause)
      }),
      (database) => Effect.sync(() => database.close())
    ).pipe(Effect.flatMap(make))
  )
