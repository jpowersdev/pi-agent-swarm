import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Hash from "effect/Hash"
import * as Layer from "effect/Layer"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as EntityId from "effect/unstable/cluster/EntityId"
import * as Sharding from "effect/unstable/cluster/Sharding"

import * as ExecutionProtocol from "./ExecutionProtocol.js"

export const shardsPerGroup = 300

const stride = 113
const maximumAttempts = shardsPerGroup * 32

const shardsByRingPosition = Array.from({ length: shardsPerGroup }, (_, index) => ({
  id: index + 1,
  position: Hash.string(`shard-${index}`)
})).sort((left, right) => left.position - right.position || left.id - right.id)

export class Error extends Schema.TaggedError<Error>()("ExecutionIdError", {
  operation: Schema.Literals(["initialize", "next"]),
  cause: Schema.Defect()
}) {}

export interface Interface {
  readonly next: Effect.Effect<string, Error>
}

export class Service extends Context.Service<Service, Interface>()("pi-agent-swarm/ExecutionIds") {}

export const targetShard = (cursor: number): number => {
  const shard = shardsByRingPosition[(cursor * stride) % shardsPerGroup]
  if (shard === undefined) {
    throw new globalThis.Error(`Invalid execution placement cursor: ${cursor}`)
  }
  return shard.id
}

export const make = (
  sharding: Sharding.Sharding["Service"],
  nextCursor: Effect.Effect<number, Error>
): Interface => ({
  next: Effect.gen(function* () {
    const cursor = yield* nextCursor
    const target = targetShard(cursor)

    for (let nonce = 0; nonce < maximumAttempts; nonce++) {
      const executionId = `exec-${cursor.toString(36)}-${nonce.toString(36)}`
      const entityId = EntityId.make(executionId)
      const shard = sharding.getShardId(entityId, ExecutionProtocol.entity.getShardGroup(entityId))
      if (shard.id === target) return executionId
    }

    return yield* Effect.fail(new Error({
      operation: "next",
      cause: new globalThis.Error(`Could not find an execution id for shard ${target}`)
    }))
  })
})

export const layerMemory: Layer.Layer<Service, never, Sharding.Sharding> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sharding = yield* Sharding.Sharding
    const cursor = yield* Ref.make(0)
    const nextCursor = Ref.getAndUpdate(cursor, (value) => value + 1)
    return Service.of(make(sharding, nextCursor))
  })
)
