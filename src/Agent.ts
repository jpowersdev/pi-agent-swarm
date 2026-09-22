import * as NodeOs from "node:os"

import * as Config from "effect/Config"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"

import { ModelRuntime, ResourceLoader, Session } from "@jpowersdev/effect-pi"

import * as Workspace from "./Workspace.js"
import * as WorkspaceTools from "./WorkspaceTools.js"

const agentDirectory = `${NodeOs.homedir()}/.pi/agent`

const ResourcesLive = ResourceLoader.layerEmpty({
  systemPrompt: [
    "You are the editing agent for one small JavaScript project.",
    "The project exists only through the supplied workspace tools.",
    "Inspect the project, fix its failing test, and call run_tests.",
    "Do not report success until run_tests reports PASS."
  ].join(" "),
  settings: { retry: { enabled: false } }
})

export const modelLayer = ModelRuntime.layerConfig(
  Config.all({
    provider: Config.NonEmptyString("SWARM_PROVIDER").pipe(Config.withDefault("openai-codex")),
    modelId: Config.NonEmptyString("SWARM_MODEL").pipe(Config.withDefault("gpt-6-astra"))
  }).pipe(
    Config.map(({ provider, modelId }) => ({
      model: { provider, id: modelId },
      authPath: `${agentDirectory}/auth.json`,
      modelsPath: null,
      modelsStorePath: `${agentDirectory}/models-store.json`,
      refreshOnCreate: false
    }))
  )
).pipe(Layer.provide(ResourcesLive))

export const run = Effect.fn("Agent.run")(function* (
  repository: string,
  executor: WorkspaceTools.TestExecutor
) {
  const workspace = yield* Workspace.make(repository)
  const tools = WorkspaceTools.make(workspace, executor)

  const session = yield* Session.make({
    id: Session.Id.make("swarm-fixture"),
    cwd: repository,
    configure: () => ({
      tools: [...tools.names],
      customTools: [...tools.definitions]
    })
  })

  yield* session.events.pipe(
    Stream.filter((event) => event._tag !== "TextDelta"),
    Stream.runForEach((event) => Console.log(event)),
    Effect.forkScoped({ startImmediately: true })
  )

  const result = yield* session.prompt(
    "Inspect the project, fix the failing test, and verify the fix using run_tests."
  ).pipe(Effect.timeout("5 minutes"))

  const checkpoint = yield* workspace.checkpoint("prompt complete")

  yield* Console.log("Assistant:", result.text)
  yield* Console.log("Final commit:", checkpoint.commit)
  yield* Console.log("Usage:", {
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    costUsd: result.costUsd
  })
})
