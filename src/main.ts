import { fileURLToPath } from "node:url"

import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"

import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore"

import * as Agent from "./Agent.js"
import * as Firecracker from "./Firecracker.js"

const projectRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "")
const repository = fileURLToPath(new URL("../.data/fixture", import.meta.url)).replace(/\/$/, "")
const firecracker = Firecracker.make(projectRoot)

Agent.run(repository, {
  test: (commit) => firecracker.test(repository, commit)
}).pipe(
  Effect.scoped,
  Effect.provide(Layer.mergeAll(
    Agent.modelLayer,
    NodeServices.layer,
    KeyValueStore.layerMemory
  )),
  NodeRuntime.runMain
)
