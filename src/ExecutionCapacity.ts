import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Semaphore from "effect/Semaphore"

export interface Interface {
  readonly withPermit: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

export class Service extends Context.Service<Service, Interface>()("pi-agent-swarm/ExecutionCapacity") {}

export const layer = (capacity: number): Layer.Layer<Service> =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      if (!Number.isInteger(capacity) || capacity < 1) {
        return yield* Effect.die(new globalThis.Error(`Invalid execution capacity: ${capacity}`))
      }
      const semaphore = yield* Semaphore.make(capacity)
      return Service.of({ withPermit: semaphore.withPermit })
    })
  )
