import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import { fileURLToPath } from "node:url"

import * as Config from "effect/Config"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"

import * as ExecutionBackend from "./ExecutionBackend.js"
import * as ExecutorDaemon from "./ExecutorDaemon.js"
import * as RemoteExecutionStore from "./RemoteExecutionStore.js"

const projectRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "")
const repository = fileURLToPath(new URL("../../pi-agent-swarm-fixture", import.meta.url)).replace(/\/$/, "")

const program = Effect.gen(function* () {
  const executorId = yield* Config.NonEmptyString("SWARM_EXECUTOR_ID")
  const capacity = yield* Config.Int("SWARM_EXECUTOR_CAPACITY").pipe(Config.withDefault(1))

  const daemon = yield* ExecutorDaemon.make({
    executorId,
    capacity,
    leaseMillis: 30_000,
    pollInterval: "50 millis",
    heartbeatInterval: "1 second"
  })

  yield* Console.log(`Starting executor ${executorId} with capacity ${capacity}`)
  return yield* daemon.run
}).pipe(
  Effect.scoped,
  Effect.provide([
    RemoteExecutionStore.layer("http://127.0.0.1:8787"),
    ExecutionBackend.firecrackerLayer(projectRoot, repository)
  ])
)

NodeRuntime.runMain(program)
