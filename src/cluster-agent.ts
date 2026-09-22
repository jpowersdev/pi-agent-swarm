import { fileURLToPath } from "node:url"

import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"

import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore"

import * as Agent from "./Agent.js"
import * as ClusterExecutionClient from "./ClusterExecutionClient.js"
import * as Executions from "./Executions.js"
import * as WorkspaceTools from "./WorkspaceTools.js"

const repository = fileURLToPath(new URL("../../pi-agent-swarm-fixture", import.meta.url)).replace(/\/$/, "")

Effect.gen(function* () {
  const executions = yield* Executions.Service
  yield* Agent.run(repository, WorkspaceTools.clusterTestExecutor(executions))
}).pipe(
  Effect.scoped,
  Effect.provide(Layer.mergeAll(
    Agent.modelLayer,
    ClusterExecutionClient.layer,
    NodeServices.layer,
    KeyValueStore.layerMemory
  )),
  NodeRuntime.runMain
)
