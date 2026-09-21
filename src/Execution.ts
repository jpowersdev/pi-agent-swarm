import * as Schema from "effect/Schema"

export const Action = Schema.Literals(["test"])
export type Action = typeof Action.Type

export const State = Schema.Literals([
  "queued",
  "leased",
  "running",
  "succeeded",
  "failed",
  "cancelled"
])
export type State = typeof State.Type

export const ExecutorState = Schema.Literals(["ready", "draining", "unavailable"])
export type ExecutorState = typeof ExecutorState.Type

export const Request = Schema.Struct({
  commit: Schema.String,
  action: Action
})
export interface Request extends Schema.Schema.Type<typeof Request> {}

export const Record = Schema.Struct({
  executionId: Schema.String,
  commit: Schema.String,
  action: Action,
  state: State,
  submittedAt: Schema.Number,
  executorId: Schema.NullOr(Schema.String),
  leaseExpiresAt: Schema.NullOr(Schema.Number),
  startedAt: Schema.NullOr(Schema.Number),
  finishedAt: Schema.NullOr(Schema.Number),
  exitCode: Schema.NullOr(Schema.Number),
  output: Schema.NullOr(Schema.String),
  durationMillis: Schema.NullOr(Schema.Number)
})
export interface Record extends Schema.Schema.Type<typeof Record> {}

export const Lease = Schema.Struct({
  execution: Record,
  token: Schema.String
})
export interface Lease extends Schema.Schema.Type<typeof Lease> {}

export const Outcome = Schema.Struct({
  passed: Schema.Boolean,
  exitCode: Schema.Number,
  output: Schema.String,
  durationMillis: Schema.Number
})
export interface Outcome extends Schema.Schema.Type<typeof Outcome> {}

export const Executor = Schema.Struct({
  executorId: Schema.String,
  capacity: Schema.Number,
  state: ExecutorState,
  heartbeatAt: Schema.Number
})
export interface Executor extends Schema.Schema.Type<typeof Executor> {}

export const ExecutorCapacity = Schema.Struct({
  ...Executor.fields,
  active: Schema.Number,
  available: Schema.Number
})
export interface ExecutorCapacity extends Schema.Schema.Type<typeof ExecutorCapacity> {}

export const Fleet = Schema.Struct({
  queued: Schema.Number,
  leased: Schema.Number,
  running: Schema.Number,
  executors: Schema.Array(ExecutorCapacity)
})
export interface Fleet extends Schema.Schema.Type<typeof Fleet> {}
