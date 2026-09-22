import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

import * as Execution from "./Execution.js"

export class Error extends Schema.TaggedError<Error>()("ExecutionsError", {
  executionId: Schema.String,
  operation: Schema.Literals(["await", "cancel", "get", "submit"]),
  message: Schema.String
}) {}

export interface Interface {
  readonly submit: (request: Execution.Request) => Effect.Effect<Execution.Record, Error>
  readonly get: (executionId: string) => Effect.Effect<Option.Option<Execution.Record>, Error>
  readonly await: (executionId: string) => Effect.Effect<Execution.Record, Error>
  readonly cancel: (executionId: string) => Effect.Effect<boolean, Error>
}

export class Service extends Context.Service<Service, Interface>()("pi-agent-swarm/Executions") {}
