import * as Entity from "effect/unstable/cluster/Entity"
import { Persisted } from "effect/unstable/cluster/ClusterSchema"
import * as Rpc from "effect/unstable/rpc/Rpc"

import * as Execution from "./Execution.js"
import * as Executions from "./Executions.js"

export const Start = Rpc.make("Start", {
  payload: Execution.Request,
  error: Executions.Error
}).annotate(Persisted, true)

export const Cancel = Rpc.make("Cancel", {
  success: Execution.Record,
  error: Executions.Error
}).annotate(Persisted, true)

export const entity = Entity.make("Execution", [Start, Cancel])
