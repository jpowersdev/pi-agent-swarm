# Distributed executor direction

This document sketches the system this experiment is intended to grow toward. It is a direction, not a settled protocol or implementation plan.

## Goal

Run an agent-created Git revision in a Firecracker microVM on a dedicated Linux/KVM executor without transferring or rebuilding the complete repository for every invocation.

The session service owns the model conversation and workspace edits. The executor owns untrusted code execution. The model never receives host access, Firecracker control, or executor credentials.

```text
Session service
  │ exact commit IDs + missing Git objects + execution policy
  ▼
Executor API on a Linux/KVM host
  ├── runtime images cached by digest
  ├── bare Git mirrors/object caches
  ├── workspace bases cached by exact commit
  └── per-session writable workspace layers
          │ local block device
          ▼
     Firecracker microVM
```

## Repository and workspace model

The executor may regularly fetch a repository's main branch to warm its Git object cache, but `main` is not an execution identity. Every request names an immutable base commit and target commit. This keeps a job reproducible if the branch moves while a session is running.

For a session based on commit `M1` that produces commit `S1`:

1. The executor ensures that it has `M1`, fetching it on a cache miss.
2. The session service sends only the Git objects needed for `M1..S1`, for example as a thin pack or bundle.
3. The executor imports and validates those objects.
4. The executor constructs a local workspace representing exactly `S1`.
5. It attaches that workspace to the microVM as a block device.

Session-created commits generally do not exist in the upstream repository, so fetching `main` alone is insufficient. A cold executor may need the full base once; later requests should reuse its cached objects and workspace artifacts.

The workspace is prepared before boot. It is not streamed file-by-file into the running guest.

## Materialization strategy

A first distributed version can create a local Git worktree for the target commit and build an ext4 image, as the current experiment does. This removes repeated network transfer but still performs work proportional to the complete checkout size.

The intended optimization is to cache a prepared workspace base for an exact commit and create a cheap writable derivative for each session. Candidate mechanisms include reflinked images, block-level copy-on-write snapshots, or a read-only base filesystem with a writable overlay. The specific mechanism remains to be chosen.

Repeated executions in one session should retain the session layer for a bounded period and apply only newly created objects and changed paths. Teardown discards that writable layer. Cached base artifacts remain immutable and are keyed by repository identity and commit or tree digest.

Runtime/toolchain files and dependencies are a separate layer, cached by an immutable image digest. They should not be copied into every repository workspace.

## Executor API shape

The API should submit constrained execution jobs rather than expose a general remote shell. A request will need approximately:

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

Longer-running jobs likely need submit, observe/stream, cancel, and result operations. Results include the exact target commit, exit status, bounded output, duration, and any explicitly permitted artifacts. The runtime image maps validated actions such as `test`, `build`, `typecheck`, and `lint` to repository-specific commands; the public API does not accept an unrestricted host shell command.

## Fleet and scheduling model

The executor API is one logical service, not one execution machine. A durable queue and capacity-aware scheduler distribute requests across resident executor daemons:

```text
Clients
  │ submit / await / cancel
  ▼
Execution API and durable queue
  │ atomic slot leases
  ▼
Capacity-aware scheduler
  ├── Executor A: 6 of 8 slots used
  ├── Executor B: 3 of 8 slots used
  └── Executor C: draining
          │
          ▼
  local Firecracker microVMs
```

An executor advertises:

- a stable executor ID and heartbeat;
- health and lifecycle state: `ready`, `draining`, or `unavailable`;
- total, reserved, and running capacity;
- supported architectures and runtime images;
- cached repository bases and toolchain images;
- current CPU, memory, disk, and KVM pressure.

The first implementation can use one fixed-size slot per microVM. Later, execution profiles can reserve differing CPU and memory amounts. Capacity must be reserved with an atomic, expiring lease before dispatch so concurrent schedulers cannot over-assign a daemon. A request stays queued when no compatible lease is available.

Scheduling should first enforce compatibility and available capacity, then prefer an executor that already caches the requested runtime image and repository base. Cache affinity is an optimization, never part of correctness: every execution remains identified by immutable digests and commits.

A durable execution record should move through explicit states such as `queued`, `leased`, `running`, and a terminal `succeeded`, `failed`, `cancelled`, or `timed_out` state. Heartbeat and lease expiry recover jobs from a dead daemon. An execution ID deduplicates submission and result publication. Retrying an isolated build or test can be allowed by policy; this does not imply that model prompts or arbitrary external side effects are replay-safe.

## Kubernetes role

Kubernetes manages the executor fleet, but it is deliberately absent from the latency-sensitive execution path. Creating a Kubernetes Job or Pod for every test would add scheduling, sandbox, image, and readiness latency before Firecracker even starts. Instead, Kubernetes keeps executor daemons resident and each daemon launches microVMs directly on its local `/dev/kvm` host:

```text
Hot path:
request → reserve resident daemon → launch/restore Firecracker → execute

Capacity path:
queue pressure → request another KVM node → start daemon → register slots
```

The normal topology is one executor daemon per dedicated KVM node. This can be represented by a DaemonSet while a separate capacity controller adjusts the node pool, or by a Deployment with one-per-node affinity whose pending Pods cause Karpenter or Cluster Autoscaler to provision nodes. Merely scheduling another daemon on an already saturated host does not create additional VM capacity.

Autoscaling should use queued demand, queue wait time, leased/running slots, and aggregate free capacity rather than CPU utilization alone. It should preserve a configurable amount of warm headroom and a minimum fleet size because provisioning a new node is much slower than launching a microVM. Bursts wait in the durable queue instead of overcommitting hosts.

Scale-in is coordinated rather than abrupt:

1. Mark an executor `draining` so it receives no new leases.
2. Allow active executions to finish or reach their deadlines.
3. Upload final results and release retained session layers.
4. Remove the daemon and then the node.

The daemon should run Firecracker through the jailer under dedicated host identities and cgroups. Kubernetes credentials, execution-control credentials, model credentials, and repository-origin credentials must not be mounted into guests.

## Security boundary

Guest code is hostile even when the model cannot invoke arbitrary shell commands. The executor must authenticate requests and validate artifact digests, commits, semantic actions, and resource limits. Production execution should use the Firecracker jailer plus separate host users, cgroups, seccomp, timeouts, output limits, and controlled or absent networking. Requests must never contain arbitrary executor host paths.

Warm memory snapshots may eventually reduce boot time, but they do not replace workspace handling: Firecracker snapshots cover guest memory and device state while disk artifacts remain separately managed.

## Suggested progression

1. Put the existing Firecracker launch behind a small local executor API.
2. Address jobs by exact runtime and Git commit digests.
3. Separate session and executor hosts; transfer a Git bundle/pack rather than an ext4 image.
4. Add bare-repository and runtime-image caches on the executor.
5. Retain bounded per-session workspaces across repeated test runs.
6. Replace full ext4 reconstruction with a measured copy-on-write or overlay strategy.
7. Add the durable execution state machine, slot leases, cancellation, and bounded result storage.
8. Deploy one resident executor daemon per dedicated Kubernetes KVM node.
9. Add cache-aware routing, warm-capacity autoscaling, coordinated draining, and garbage collection.
10. Add production isolation and observe queue, launch, guest, and total execution latency independently.
