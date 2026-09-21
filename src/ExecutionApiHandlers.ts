import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { HttpApiBuilder } from "effect/unstable/httpapi"

import { Api } from "./ExecutionApi.js"
import * as ExecutionStore from "./ExecutionStore.js"

export const layer = HttpApiBuilder.group(
  Api,
  "control",
  Effect.fn("ExecutionApiHandlers.control")(function* (handlers) {
    const store = yield* ExecutionStore.Service

    return handlers.handleAll({
      health: () => Effect.succeed({ ok: true }),
      submit: ({ payload }) => store.submit(payload).pipe(Effect.orDie),
      getExecution: ({ params }) => store.get(params.executionId).pipe(
        Effect.map(Option.getOrNull),
        Effect.orDie
      ),
      listExecutions: () => store.list().pipe(Effect.orDie),
      fleet: () => store.fleet().pipe(Effect.orDie),
      cancel: ({ params }) => store.cancel(params.executionId).pipe(
        Effect.map((ok) => ({ ok })),
        Effect.orDie
      ),
      registerExecutor: ({ payload }) =>
        store.registerExecutor(payload.executorId, payload.capacity).pipe(Effect.orDie),
      heartbeat: ({ params }) => store.heartbeat(params.executorId).pipe(
        Effect.as({ ok: true }),
        Effect.orDie
      ),
      drain: ({ params }) => store.drain(params.executorId).pipe(
        Effect.as({ ok: true }),
        Effect.orDie
      ),
      lease: ({ params, payload }) => store.leaseNext(params.executorId, payload.leaseMillis).pipe(
        Effect.map((lease) => ({ lease: Option.getOrNull(lease) })),
        Effect.orDie
      ),
      markRunning: ({ params, payload }) => store.markRunning(params.executionId, payload.token).pipe(
        Effect.as({ ok: true }),
        Effect.orDie
      ),
      complete: ({ params, payload }) =>
        store.complete(params.executionId, payload.token, payload.outcome).pipe(Effect.orDie)
    })
  })
)

export const provided = (storeLayer: Layer.Layer<ExecutionStore.Service, ExecutionStore.Error>) =>
  layer.pipe(Layer.provide(storeLayer))
