import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { HttpApiClient } from "effect/unstable/httpapi"

import { Api } from "./ExecutionApi.js"
import * as ExecutionStore from "./ExecutionStore.js"

const remoteError = (operation: ExecutionStore.Error["operation"]) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, ExecutionStore.Error, R> =>
    effect.pipe(Effect.mapError((cause) => new ExecutionStore.Error({ operation, cause })))

export const layer = (baseUrl: string): Layer.Layer<ExecutionStore.Service> =>
  Layer.effect(
    ExecutionStore.Service,
    Effect.gen(function* () {
      const client = yield* HttpApiClient.make(Api, {
        transformClient: (httpClient) => httpClient.pipe(
          HttpClient.mapRequest(HttpClientRequest.prependUrl(baseUrl))
        )
      })

      const control = client.control

      return ExecutionStore.Service.of({
        submit: Effect.fn("RemoteExecutionStore.submit")((request) =>
          control.submit({ payload: request }).pipe(remoteError("submit"))),
        get: Effect.fn("RemoteExecutionStore.get")((executionId) =>
          control.getExecution({ params: { executionId } }).pipe(
            Effect.map(Option.fromNullOr),
            remoteError("get")
          )),
        list: Effect.fn("RemoteExecutionStore.list")(() =>
          control.listExecutions().pipe(remoteError("list"))),
        fleet: Effect.fn("RemoteExecutionStore.fleet")(() =>
          control.fleet().pipe(remoteError("fleet"))),
        cancel: Effect.fn("RemoteExecutionStore.cancel")((executionId) =>
          control.cancel({ params: { executionId } }).pipe(
            Effect.map((response) => response.ok),
            remoteError("cancel")
          )),
        registerExecutor: Effect.fn("RemoteExecutionStore.registerExecutor")((executorId, capacity) =>
          control.registerExecutor({ payload: { executorId, capacity } }).pipe(remoteError("register"))),
        heartbeat: Effect.fn("RemoteExecutionStore.heartbeat")((executorId) =>
          control.heartbeat({ params: { executorId } }).pipe(
            Effect.asVoid,
            remoteError("heartbeat")
          )),
        drain: Effect.fn("RemoteExecutionStore.drain")((executorId) =>
          control.drain({ params: { executorId } }).pipe(
            Effect.asVoid,
            remoteError("drain")
          )),
        leaseNext: Effect.fn("RemoteExecutionStore.leaseNext")((executorId, leaseMillis) =>
          control.lease({
            params: { executorId },
            payload: { leaseMillis }
          }).pipe(
            Effect.map((response) => Option.fromNullOr(response.lease)),
            remoteError("lease")
          )),
        markRunning: Effect.fn("RemoteExecutionStore.markRunning")((executionId, token) =>
          control.markRunning({
            params: { executionId },
            payload: { token }
          }).pipe(
            Effect.asVoid,
            remoteError("markRunning")
          )),
        complete: Effect.fn("RemoteExecutionStore.complete")((executionId, token, outcome) =>
          control.complete({
            params: { executionId },
            payload: { token, outcome }
          }).pipe(remoteError("complete")))
      })
    })
  ).pipe(Layer.provide(FetchHttpClient.layer))
