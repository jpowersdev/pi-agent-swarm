import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { fileURLToPath } from "node:url"

import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Schedule from "effect/Schedule"

import * as ExecutionBackend from "./ExecutionBackend.js"
import * as ExecutionStore from "./ExecutionStore.js"
import * as ExecutorDaemon from "./ExecutorDaemon.js"
import * as Process from "./Process.js"

const projectRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "")
const repository = fileURLToPath(new URL("../../pi-agent-swarm-fixture", import.meta.url)).replace(/\/$/, "")
const databasePath = `${projectRoot}/.data/executions.sqlite`

const program = Effect.gen(function* () {
  const store = yield* ExecutionStore.Service
  const revision = yield* Process.successful("git", ["rev-parse", "HEAD"], { cwd: repository })
  const commit = revision.stdout.trim()

  const executorA = yield* ExecutorDaemon.make({
    executorId: "local-a",
    capacity: 1,
    leaseMillis: 30_000,
    pollInterval: "10 millis",
    heartbeatInterval: "1 second"
  })
  const executorB = yield* ExecutorDaemon.make({
    executorId: "local-b",
    capacity: 1,
    leaseMillis: 30_000,
    pollInterval: "10 millis",
    heartbeatInterval: "1 second"
  })

  yield* executorA.register
  yield* executorB.register

  const submitted = yield* Effect.all([
    store.submit({ commit, action: "test" }),
    store.submit({ commit, action: "test" }),
    store.submit({ commit, action: "test" })
  ])
  const executionIds = new Set(submitted.map((execution) => execution.executionId))
  const currentExecutions = store.list().pipe(
    Effect.map((executions) => executions.filter((execution) => executionIds.has(execution.executionId)))
  )

  const first = yield* executorA.runOne.pipe(Effect.forkScoped)
  const second = yield* executorB.runOne.pipe(Effect.forkScoped)

  const saturated = yield* currentExecutions.pipe(
    Effect.repeat({
      until: (executions) =>
        executions.filter((execution) => execution.state === "running").length === 2 &&
        executions.filter((execution) => execution.state === "queued").length === 1,
      schedule: Schedule.spaced("10 millis")
    })
  )

  yield* Console.log("At saturation:", saturated.map(({ executionId, executorId, state }) => ({
    executionId,
    executorId,
    state
  })))

  yield* Fiber.join(first)
  yield* Fiber.join(second)

  yield* executorA.runOne

  const completed = yield* currentExecutions
  yield* Console.log("Completed:", completed.map((execution) => ({
    executionId: execution.executionId,
    executorId: execution.executorId,
    state: execution.state,
    durationMillis: execution.durationMillis
  })))
}).pipe(Effect.scoped)

const StoreLive = ExecutionStore.layer(databasePath).pipe(
  Layer.provide(NodeServices.layer)
)

program.pipe(
  Effect.provide([
    StoreLive,
    ExecutionBackend.firecrackerLayer(projectRoot, repository)
  ]),
  NodeRuntime.runMain
)
