# Distributed executor direction

This document describes the system the working Cluster proof is intended to grow toward. It is a direction, not a settled deployment plan.

## Goal

Run an agent-created Git revision in a Firecracker microVM on a dedicated Linux/KVM runner without transferring or rebuilding the complete repository for every invocation.

The session runner owns the model conversation and VFS edits. An execution entity owns untrusted code execution. The model never receives host access, Firecracker control, or runner credentials.

```text
Session entity
  │ immutable checkpoint + semantic action
  ▼
Execution entity
  │ Effect Cluster placement and durable mailbox
  ▼
KVM runner process
  ├── runner-local VM capacity
  ├── runtime images cached by digest
  ├── bare Git mirrors/object caches
  ├── workspace bases cached by exact commit
  └── scoped Firecracker microVM
```

## Repository and workspace model

A runner may regularly fetch a repository's main branch to warm its Git object cache, but `main` is not an execution identity. Every request names an immutable base commit and target commit. This keeps a job reproducible if the branch moves while a session is running.

For a session based on commit `M1` that produces commit `S1`:

1. The runner ensures that it has `M1`, fetching it on a cache miss.
2. The session side sends only the Git objects needed for `M1..S1`, such as a thin pack or bundle.
3. The runner imports and validates those objects.
4. The execution entity constructs a workspace representing exactly `S1`.
5. It attaches that workspace to its Firecracker microVM.

Session-created commits generally do not exist upstream, so fetching `main` is insufficient. A cold runner may need the full base once; later requests should reuse cached objects and workspace artifacts.

The workspace is prepared before boot. It is not streamed file-by-file into the running guest.

## Materialization strategy

The current implementation creates a detached Git worktree and a complete ext4 image. This proves correctness but performs work proportional to the checkout size.

The intended optimization is to cache a prepared workspace base for an exact commit and create a cheap writable derivative for each session. Candidate mechanisms include reflinked images, block-level copy-on-write snapshots, or a read-only base filesystem with a writable overlay.

Repeated executions in one session should retain a bounded session layer and apply only new Git objects and changed paths. Cached base artifacts remain immutable. Runtime/toolchain files and dependencies form a separate layer keyed by an immutable image digest.

## Execution interface

The caller uses a small `Executions` interface:

```text
submit(request)
get(executionId)
await(executionId)
cancel(executionId)
```

A request contains immutable artifact references and a constrained semantic action rather than an unrestricted shell command:

```json
{
  "repository": "repository-identity",
  "baseCommit": "M1",
  "targetCommit": "S1",
  "gitObjects": "artifact-or-pack-reference",
  "runtimeImage": "sha256:...",
  "action": {
    "name": "test",
    "target": null
  },
  "limits": {
    "cpus": 1,
    "memoryMiB": 512,
    "timeoutSeconds": 30,
    "outputBytes": 1048576
  }
}
```

The runtime image maps validated actions such as `test`, `build`, `typecheck`, and `lint` to repository-specific commands.

## Cluster and capacity model

Every execution ID addresses one Effect Cluster entity. Cluster provides durable message delivery, shard ownership, runner discovery, location-transparent clients, and scoped entity shutdown.

Each runner separately advertises or is configured with local VM capacity. Its shard weight follows that capacity. `ExecutionCapacity` currently uses a semaphore, releasing a slot immediately when Firecracker exits. `maxResidentEntities` remains a safety bound for entity shells rather than the live-VM limit because passivation is intentionally less immediate.

A shared sequence spreads consecutive execution IDs across low-discrepancy shard-ring positions. This smooths small bursts without inspecting runner ownership and continues to work as membership changes.

```text
Cluster mailbox
  ├── runner A: capacity 8, active 6
  ├── runner B: capacity 8, active 3
  └── runner C: draining
```

Cluster does not provision operating-system processes or machines. A small external capacity controller can observe durable queued/running counts and runner health, then start or stop ordinary runner processes through any suitable mechanism: systemd, Nomad, ECS, a cloud machine API, or a custom supervisor.

Scale-in is coordinated:

1. Stop assigning new shards or mark the runner unavailable.
2. Allow active execution entities to complete or reach their deadlines.
3. Close the runner scope, which interrupts remaining Firecracker children.
4. Remove the process or machine.

Current Effect shard placement is not dynamically load-aware. The ID heuristic, shard weights, and VM permits improve distribution and prevent overload, but a runner may still queue assigned work while another has spare capacity. The capacity controller must tolerate this; stronger scheduling would require runner-compatible IDs or explicit assignment metadata.

## Durability

Execution records move through `queued`, `running`, and terminal `succeeded`, `failed`, or `cancelled` states. An execution ID is the idempotency key.

`Start` can be persisted because launch is guarded by the durable `queued → running` transition. A duplicate message cannot create a second VM. A running record found after a fresh activation is considered orphaned and failed unless a future recovery protocol can prove that resuming is safe.

This execution-specific idempotency does not make model prompts replay-safe.

## Security boundary

Guest code is hostile even when the model cannot invoke arbitrary shell commands. Runners must validate artifact digests, commits, semantic actions, and resource limits. Production execution should use the Firecracker jailer plus dedicated host identities, cgroups, seccomp, deadlines, output limits, and controlled or absent networking. Requests must never contain arbitrary runner host paths.

Warm memory snapshots may reduce boot time, but they do not replace workspace handling: Firecracker snapshots cover guest memory and device state while disk artifacts remain separately managed.

## Suggested progression

1. Exercise the PostgreSQL-backed Cluster and execution-store adapters across separate hosts.
2. Address jobs by exact runtime, repository, commit, and object digests.
3. Transfer a Git bundle or thin pack rather than assuming a shared checkout.
4. Add bare-repository and runtime-image caches on each runner.
5. Replace full ext4 reconstruction with a measured copy-on-write workspace strategy.
6. Add deadlines, bounded output, artifact publication, and richer cancellation results.
7. Add runner draining and a platform-neutral process capacity controller.
8. Measure the low-discrepancy placement heuristic under bursty and heterogeneous workloads.
9. Add production jailer isolation, authentication, observability, and garbage collection.
