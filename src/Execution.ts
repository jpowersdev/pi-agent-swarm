import * as Schema from "effect/Schema"

export const Action = Schema.Literals(["test"])
export type Action = typeof Action.Type

export const State = Schema.Literals([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled"
])
export type State = typeof State.Type

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
  runnerAddress: Schema.NullOr(Schema.String),
  startedAt: Schema.NullOr(Schema.Number),
  finishedAt: Schema.NullOr(Schema.Number),
  exitCode: Schema.NullOr(Schema.Number),
  output: Schema.NullOr(Schema.String),
  durationMillis: Schema.NullOr(Schema.Number)
})
export interface Record extends Schema.Schema.Type<typeof Record> {}

export const Outcome = Schema.Struct({
  passed: Schema.Boolean,
  exitCode: Schema.Number,
  output: Schema.String,
  durationMillis: Schema.Number
})
export interface Outcome extends Schema.Schema.Type<typeof Outcome> {}

export const isTerminal = (execution: Record): boolean =>
  execution.state === "succeeded" ||
  execution.state === "failed" ||
  execution.state === "cancelled"
