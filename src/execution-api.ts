import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { createServer } from "node:http"
import { fileURLToPath } from "node:url"

import * as Layer from "effect/Layer"
import { HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"

import { Api } from "./ExecutionApi.js"
import * as ExecutionApiHandlers from "./ExecutionApiHandlers.js"
import * as ExecutionStore from "./ExecutionStore.js"

const projectRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "")
const port = 8787

const StoreLive = ExecutionStore.layer(`${projectRoot}/.data/executions-api.sqlite`).pipe(
  Layer.provide(NodeServices.layer)
)

const RoutesLive = HttpApiBuilder.layer(Api).pipe(
  Layer.provide(ExecutionApiHandlers.layer),
  Layer.provide(StoreLive)
)

const ServerLive = HttpRouter.serve(RoutesLive).pipe(
  Layer.provide(NodeHttpServer.layer(createServer, { port }))
)

NodeRuntime.runMain(Layer.launch(ServerLive))
