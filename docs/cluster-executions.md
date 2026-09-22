# Cluster execution entities

This proof models every execution as an Effect Cluster entity whose identity is the execution ID and whose scoped resource is a Firecracker microVM.

## Topology

```text
Executions client
  │ persisted Start RPC, volatile reads from execution store
  ▼
Effect Cluster
  ├── PostgreSQL runner discovery, shard locks, and durable mailboxes
  ├── socket transport between processes
  └── execution entity placement
          │
          ├── runner 127.0.0.1:34431 ── capacity semaphore: 1 VM
          └── runner 127.0.0.1:34432 ── capacity semaphore: 1 VM
                    │
                    ▼
              Firecracker backend
```

`Executions` is the caller interface:

```text
submit(request) → queued execution record
get(id)         → current durable record
await(id)       → terminal durable record
cancel(id)      → interrupt and clean up the VM
```

Callers do not select runners, manipulate Firecracker, or understand shard ownership.

## Entity lifecycle

`ExecutionProtocol` defines persisted `Start` and `Cancel` RPCs. `ClusterExecutions.runnerLayer` registers one `Execution` entity per execution ID.

The lifecycle is:

1. `submit` creates an idempotent `queued` record and sends `Start` in discard mode.
2. Cluster mailbox storage durably retains `Start` until the assigned runner can activate it.
3. The entity waits for one local `ExecutionCapacity` permit.
4. It atomically changes the record from `queued` to `running` and records its runner address.
5. It forks Firecracker into the entity activation scope and keeps the `Start` handler active until the VM exits.
6. Completion persists `succeeded` or `failed`, releases the permit, and allows entity passivation.
7. `Cancel` changes durable state to `cancelled` and interrupts the scoped Firecracker fiber.
8. Entity deactivation, shard movement, or runner shutdown interrupts Firecracker and records an incomplete run as failed.

The active `Start` request itself keeps the entity resident. A separate `Entity.keepAlive` message is deliberately not used: persisted keep-alive requests can outlive a process-backed resource during shard movement.

## Capacity and residency

The live-VM limit and the resident-entity limit are intentionally distinct:

- `ExecutionCapacity` is a runner-local semaphore controlling concurrent Firecracker VMs.
- `maxResidentEntities` bounds activated entity shells and queued handlers.

Effect's entity reaper has a minimum five-second resolution. Using `maxResidentEntities` as the VM slot count would leave a slot occupied for several seconds after a sub-second VM finishes. The semaphore releases immediately when Firecracker exits while the lightweight entity can passivate later.

This also lets persisted entity requests wait inside a runner without creating extra VMs. It does not make shard placement capacity-aware: work can be unevenly distributed across runners. A future capacity controller may add runners or influence submission IDs, but correctness does not depend on even placement.

## Durability and replay

Cluster `Start` messages are persisted, but the model invocation rule does not apply here: execution startup has an explicit idempotency protocol.

- The entity ID is the execution idempotency key.
- Creating an existing ID with a different request fails.
- Only `queued → running` can launch Firecracker.
- Duplicate `Start` messages observe the existing state and do not launch another VM.
- A `running` record encountered in a fresh activation is treated as orphaned and failed rather than silently replayed.
- A terminal record is never restarted.

The configured execution store is authoritative for state. Cluster mailbox storage is authoritative only for message delivery.

## Real multiprocess proof

Run:

```sh
nix develop
pnpm demo:cluster
```

The script starts:

- an ephemeral local PostgreSQL server for Effect Cluster storage;
- two independent socket runner processes;
- one client process;
- six persisted execution entities plus one cancellation case.

Each runner is configured for one concurrent VM. The validated run reached:

```text
127.0.0.1:34431 → one running VM
127.0.0.1:34432 → one running VM
four executions  → queued
```

All six executions passed inside Firecracker in approximately 0.86–0.88 seconds each. Work was distributed across both runners. A seventh running execution was cancelled, and its scoped Firecracker process was interrupted before the client received the cancellation result.

The deterministic test in `test/ClusterExecutions.test.ts` verifies serialization at capacity one, successful completion, cancellation, and interruption without requiring KVM.

## Current limitations

- Both Cluster and execution records use PostgreSQL, but the proof starts its database and runners on one machine; the same layers have not yet been exercised across hosts.
- Shard placement is not dynamically capacity-aware, so runner utilization may be uneven.
- There is no process or machine provisioner yet; Cluster coordinates runners that already exist.
- The semantic action set contains only `test`.
- Workspace transfer still assumes the fixture repository exists on every runner.
- Firecracker runs directly rather than through the jailer.
- Output is stored without a production byte limit.
