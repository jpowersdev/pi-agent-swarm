import * as Schema from "effect/Schema"
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"

import * as Execution from "./Execution.js"

export const Ok = Schema.Struct({ ok: Schema.Boolean })
export interface Ok extends Schema.Schema.Type<typeof Ok> {}

export const RegisterExecutor = Schema.Struct({
  executorId: Schema.String,
  capacity: Schema.Number
})
export interface RegisterExecutor extends Schema.Schema.Type<typeof RegisterExecutor> {}

export const LeaseRequest = Schema.Struct({ leaseMillis: Schema.Number })
export interface LeaseRequest extends Schema.Schema.Type<typeof LeaseRequest> {}

export const LeaseResponse = Schema.Struct({ lease: Schema.NullOr(Execution.Lease) })
export interface LeaseResponse extends Schema.Schema.Type<typeof LeaseResponse> {}

export const Token = Schema.Struct({ token: Schema.String })
export interface Token extends Schema.Schema.Type<typeof Token> {}

export const Complete = Schema.Struct({
  token: Schema.String,
  outcome: Execution.Outcome
})
export interface Complete extends Schema.Schema.Type<typeof Complete> {}

export class ControlGroup extends HttpApiGroup.make("control")
  .add(
    HttpApiEndpoint.get("health", "/health", { success: Ok }),
    HttpApiEndpoint.post("submit", "/executions", {
      payload: Execution.Request,
      success: Execution.Record
    }),
    HttpApiEndpoint.get("getExecution", "/executions/:executionId", {
      params: { executionId: Schema.String },
      success: Schema.NullOr(Execution.Record)
    }),
    HttpApiEndpoint.get("listExecutions", "/executions", {
      success: Schema.Array(Execution.Record)
    }),
    HttpApiEndpoint.get("fleet", "/fleet", {
      success: Execution.Fleet
    }),
    HttpApiEndpoint.post("cancel", "/executions/:executionId/cancel", {
      params: { executionId: Schema.String },
      success: Ok
    }),
    HttpApiEndpoint.post("registerExecutor", "/executors", {
      payload: RegisterExecutor,
      success: Execution.Executor
    }),
    HttpApiEndpoint.post("heartbeat", "/executors/:executorId/heartbeat", {
      params: { executorId: Schema.String },
      success: Ok
    }),
    HttpApiEndpoint.post("drain", "/executors/:executorId/drain", {
      params: { executorId: Schema.String },
      success: Ok
    }),
    HttpApiEndpoint.post("lease", "/executors/:executorId/lease", {
      params: { executorId: Schema.String },
      payload: LeaseRequest,
      success: LeaseResponse
    }),
    HttpApiEndpoint.post("markRunning", "/executions/:executionId/start", {
      params: { executionId: Schema.String },
      payload: Token,
      success: Ok
    }),
    HttpApiEndpoint.post("complete", "/executions/:executionId/complete", {
      params: { executionId: Schema.String },
      payload: Complete,
      success: Execution.Record
    })
  ) {}

export class Api extends HttpApi.make("pi-agent-swarm-executions")
  .add(ControlGroup) {}
