# Execution control-plane proof of concept

This is the first implementation step toward the fleet described in [`distributed-executor.md`](distributed-executor.md). It proves capacity-aware routing across separate resident processes on one KVM machine. Kubernetes is intentionally not involved yet.

## Components

```text
distributed-demo client
  │ schema-validated HTTP
  ▼
execution-api process
  ├── SQLite execution records
  ├── FIFO queue
  ├── executor registry and heartbeats
  └── atomic capacity leases
        │                 │
        ▼                 ▼
executor process A    executor process B
capacity: 1           capacity: 1
        │                 │
        ▼                 ▼
Firecracker VM        Firecracker VM
```

The implementation is split by responsibility:

- `Execution.ts` defines execution, lease, executor, outcome, and fleet schemas.
- `ExecutionStore.ts` owns the SQLite state machine and atomic leases.
- `ExecutionApi.ts` defines the Effect HTTP API contract.
- `ExecutionApiHandlers.ts` maps the transport to the store.
- `RemoteExecutionStore.ts` implements the same store interface over the typed HTTP client.
- `ExecutorDaemon.ts` registers capacity, heartbeats, leases work, invokes a backend, and completes work.
- `ExecutionBackend.ts` adapts an execution to the existing Firecracker runner.
- `execution-api.ts` and `executor-daemon.ts` are separate process entrypoints.

## State and lease model

An execution starts in `queued`, moves through `leased` and `running`, and ends as `succeeded`, `failed`, or `cancelled`.

```text
queued → leased → running → succeeded
                   └──────→ failed
queued ───────────────────→ cancelled
```

Each executor registers a positive integer capacity. Leasing runs inside a SQLite `BEGIN IMMEDIATE` transaction. The transaction checks that the executor is ready, counts its `leased` and `running` executions, selects the oldest queued execution, and conditionally assigns it a unique lease token. This prevents two concurrent polling lanes from claiming the same execution or exceeding advertised capacity.

Lease tokens are required to start and complete an execution. Expired jobs that never reached `running` return to the queue on the next lease attempt. The fleet endpoint reports queue state and per-executor `active` and `available` slots, providing the initial signal an autoscaler will consume.

## HTTP surface

The schema-first Effect API currently exposes:

```text
GET  /health
GET  /fleet
POST /executions
GET  /executions
GET  /executions/:executionId
POST /executions/:executionId/cancel
POST /executions/:executionId/start
POST /executions/:executionId/complete
POST /executors
POST /executors/:executorId/heartbeat
POST /executors/:executorId/drain
POST /executors/:executorId/lease
```

Only the semantic `test` action is accepted. An execution names an immutable Git commit; it does not contain a shell command or executor host path.

## Run the proof

Prepare the Firecracker assets and ensure the adjacent fixture is on its passing agent commit, then run:

```sh
nix develop
pnpm prepare:firecracker
pnpm demo:distributed
```

The script builds the project, starts one API process and two one-slot executor processes, submits three jobs, and cleans up all processes afterward. It verifies and prints the saturated state before awaiting completion.

The validated run showed:

```text
process-a: active 1, available 0
process-b: active 1, available 0
queue:     1
```

The first two jobs ran concurrently in separate Firecracker microVMs. The third remained queued and was leased as soon as one executor became available. All three completed successfully in approximately 0.85–0.89 seconds each.

Execution state survives API process restarts in `.data/executions-api.sqlite`. Generated VM drives and logs remain under ignored `.data/` paths.

## Current limitations

This is a control-plane proof, not a production service:

- The API is a single process using local SQLite; it is not an HA scheduler.
- The transport has no authentication or TLS.
- Daemons poll every 50 ms rather than using long polling or notifications.
- Cancellation only removes queued work; running Firecracker processes are not remotely interrupted yet.
- A daemon that dies after marking work `running` leaves it running indefinitely. Heartbeat-based orphan recovery still needs an explicit retry policy.
- Executor compatibility and cache affinity are not considered yet.
- Repository and runtime selection are fixed in daemon configuration.
- The direct Firecracker runner does not use the jailer.

The next milestone is to add running-job cancellation and orphan recovery, then replace SQLite with a shared transactional store before deploying one daemon per Kubernetes KVM node.
