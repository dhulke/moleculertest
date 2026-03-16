# Moleculer + NATS `disableBalancer` Validation Suite

Automated validation that Moleculer's `disableBalancer: true` mode correctly delegates routing to the NATS transporter, making the system resilient to stale internal registries during rapid node churn.

## Table of Contents

- [Background: What Problem Does This Solve?](#background-what-problem-does-this-solve)
- [How `disableBalancer` Changes Routing](#how-disablebalancer-changes-routing)
- [Architecture](#architecture)
- [Quick Start](#quick-start)
- [Test Suites Explained](#test-suites-explained)
  - [Phase 1: Baseline Validation (H1-H4)](#phase-1-baseline-validation-h1-h4)
  - [Phase 2: Churn / Stale-Registry Stress Test (H5-H6, A1-A4)](#phase-2-churn--stale-registry-stress-test-h5-h6-a1-a4)
  - [Phase 3: Scale / Transport-Load Stress Test (H7-H8, B1-B4)](#phase-3-scale--transport-load-stress-test-h7-h8-b1-b4)
- [What is "Churn"?](#what-is-churn)
- [What is the "Scale" Test?](#what-is-the-scale-test)
- [Control Mode (`--disable-false`)](#control-mode---disable-false)
- [Hypotheses Reference](#hypotheses-reference)
- [Output Structure](#output-structure)
- [How to Interpret the Report](#how-to-interpret-the-report)
- [Configuration](#configuration)
- [Requirements](#requirements)
- [Appendix: Comparative Analysis — `disableBalancer=true` vs `false`](#appendix-comparative-analysis--disablebalancertrue-vs-false)

---

## Background: What Problem Does This Solve?

Moleculer is a microservices framework that maintains an **internal service registry** — a local data structure on each node that tracks which other nodes exist and what actions/events they provide. When you call `broker.call("some.action")`, Moleculer's built-in **balancer** looks up the registry, picks a target node, and sends the request directly to that node's address.

This works fine in stable environments. The problem emerges during **node churn** — when containers restart, scale up/down, or crash. After a container dies and restarts with a new identity, there is a window where other nodes' registries still contain the **old, dead node ID**. During this window, the balancer may route requests to a node that no longer exists, causing timeouts and retries.

**`disableBalancer: true`** solves this by delegating all routing to NATS. Instead of picking a specific target node, Moleculer publishes calls to an action-level NATS subject (e.g., `MOL-demo.REQB.workers.process`) with a **queue group**. NATS distributes the message to one of the currently subscribed nodes. When a node dies, its NATS connection drops, its subscription disappears instantly, and NATS routes to the remaining live subscribers — no stale registry, no timeouts.

This test suite proves that behavior empirically.

## How `disableBalancer` Changes Routing

### `disableBalancer: true` (default in this project)

```
Caller → broker.call("workers.process")
       → publishes to NATS subject: MOL-demo.REQB.workers.process [queue group]
       → NATS picks one of the subscribed workers
       → worker-a-1 OR worker-a-2 OR hybrid-1 handles it
```

If a worker dies, its NATS subscription vanishes instantly. NATS simply routes to a remaining subscriber. No retry needed.

### `disableBalancer: false` (Moleculer default)

```
Caller → broker.call("workers.process")
       → Moleculer registry picks a target: "worker-a-2"
       → publishes to NATS subject: MOL-demo.REQ.worker-a-2.<hash>
       → if worker-a-2 is dead: 15-second timeout → retry → pick another node
```

If the target node is dead but the registry hasn't updated yet, the request sits on a NATS subject with no subscriber for the full `requestTimeout` (15 seconds), then retries.

## Architecture

```
                    ┌─────────────┐
                    │  NATS Server│
                    │  (port 4222)│
                    │  (mon 8222) │
                    └──────┬──────┘
                           │
           ┌───────────────┼───────────────┐
           │               │               │
    ┌──────┴──────┐ ┌──────┴──────┐ ┌──────┴──────┐
    │  Baseline   │ │   Churn     │ │   Scale     │
    │  Services   │ │  Services   │ │  Services   │
    │  (9 nodes)  │ │ (7 nodes)   │ │ (N nodes)   │
    │  Static IDs │ │ Dynamic IDs │ │ Dynamic IDs │
    └─────────────┘ └─────────────┘ └─────────────┘
```

### Baseline Services (always running)

These services have **static, fixed node IDs** and are never restarted during tests. They provide a stable foundation for baseline measurements.

| Service | Node ID | Role | What It Does |
|---------|---------|------|------|
| worker-a-1 | `worker-a-1` | Worker | Handles `workers.process` calls |
| worker-a-2 | `worker-a-2` | Worker | Handles `workers.process` calls |
| caller-1 | `caller-1` | Caller | Originates `workers.process` calls |
| broadcaster-1 | `broadcaster-1` | Broadcaster | Sends `demo.broadcast` events, also listens for them |
| listener-b-1 | `listener-b-1` | Listener | Listens for `demo.broadcast` |
| listener-c-1 | `listener-c-1` | Listener | Listens for `demo.broadcast` |
| listener-d-1 | `listener-d-1` | Listener | Listens for `demo.broadcast` |
| listener-e-1 | `listener-e-1` | Listener | Listens for `demo.broadcast` |
| hybrid-1 | `hybrid-1` | Hybrid | Worker + caller + listener in one node |

### Churn Services (Docker Compose profile: `churn`)

These services use **dynamic node IDs** — every time a container restarts, it generates a brand-new Moleculer `nodeID` in the format `<prefix>-<timestamp>-<random>` (e.g., `cw1-1773626426713-cdetyc`). This simulates real-world container restarts where each new instance is a completely new identity.

| Service | ID Prefix | Role |
|---------|-----------|------|
| churn-worker-1/2/3 | cw1/cw2/cw3 | Workers that get killed and restarted repeatedly |
| churn-listener-1/2/3/4 | cl1/cl2/cl3/cl4 | Listeners that get killed and restarted during broadcasts |

### Scale Services (Docker Compose profile: `scale`)

These services also use dynamic node IDs and are designed to test behavior at larger fleet sizes. They are launched using `docker compose up --scale`.

| Service | ID Prefix | Role |
|---------|-----------|------|
| scale-worker (x N) | sw | Scalable workers, default 10 |
| scale-listener (x N) | sl | Scalable listeners, default 10 |

## Quick Start

### Full Validation (Build + Test + Teardown)

```bash
# Run everything in one command — builds Docker images, starts cluster,
# runs all tests, generates reports, and tears down automatically
./scripts/run-all.sh
```

### Control Experiment (compare with balancer enabled)

```bash
# Same tests but with disableBalancer=false to see the difference
./scripts/run-all.sh --disable-false
```

### Step-by-Step

```bash
# Install dependencies
npm install

# Start baseline cluster only
./scripts/up.sh

# Run validation against the running cluster
./scripts/validate.sh

# View the report
cat output/report.md

# Teardown
./scripts/down.sh
```

### Selective Test Runs

```bash
# Baseline only (skip churn and scale — fastest)
SKIP_CHURN=true SKIP_SCALE=true ./scripts/validate.sh

# Baseline + churn only (skip the heavy scale test)
SKIP_SCALE=true ./scripts/validate.sh

# Custom scale counts
SCALE_WORKERS=20 SCALE_LISTENERS=20 ./scripts/validate.sh
```

---

## Test Suites Explained

### Phase 1: Baseline Validation (H1-H4)

The baseline tests run against the 9 static services with no node churn. They establish that the basic Moleculer+NATS plumbing works correctly before any stress testing.

#### Call Distribution Test

Sends **40 calls** to `workers.process` via `caller-1` and records which worker node handled each call. With `disableBalancer=true`, NATS queue groups distribute calls across all workers (`worker-a-1`, `worker-a-2`, `hybrid-1`). The test verifies that multiple workers received calls (not just one).

**Tests hypothesis H1:** calls are routed via NATS queue groups, not Moleculer's internal balancer.

#### Broadcast Fanout Test

Sends **3 broadcasts** of the `demo.broadcast` event and then queries each listener node for receipts. All 6 listener nodes (4 dedicated listeners + broadcaster-1 + hybrid-1) should receive every broadcast.

**Tests hypothesis H2:** `broker.broadcast()` reaches all subscribers via NATS pub/sub.

#### NATS Subscription Analysis

Queries the NATS monitoring API (`/subsz`) and analyzes the subscription patterns. With `disableBalancer=true`, you see `REQB.*` subjects with queue groups (balanced requests). With `disableBalancer=false`, you see `REQ.<nodeId>` subjects instead (node-targeted requests).

**Tests hypothesis H3:** routing does not depend on per-node addressing.

#### Hybrid / Local Transport Test

The `hybrid-1` node runs both a worker service and a caller service. It makes 20 calls to `workers.process`. With `disableBalancer=true`, these calls go through NATS (even though the handler is local), so they get distributed across all workers. With `disableBalancer=false`, Moleculer short-circuits to the local handler, so hybrid-1 handles all 20 itself.

**Tests hypothesis H4:** local calls go through the transporter, not a local shortcut.

### Phase 2: Churn / Stale-Registry Stress Test (H5-H6, A1-A4)

The churn test suite spins up 7 additional containers (3 workers + 4 listeners) with dynamic node IDs, then systematically kills and restarts them while continuously sending calls and broadcasts.

#### A1: Call Routing Under Churn

1. Sends **20 pre-churn calls** to establish a baseline
2. Executes **3 restart waves**, each targeting a different churn worker:
   - Restarts the worker (killing the old container, starting a new one with a new node ID)
   - Immediately sends **15 calls** during/after each restart (with only 80ms delay between calls)
   - Waits 4 seconds for the new container to become ready
   - Discovers the new node ID via NATS monitoring
3. Sends **20 post-churn calls** after everything stabilizes
4. Checks for **zombie calls** — responses that came from a node ID that should be dead

Total: ~85 calls. Success rate should be 100% with `disableBalancer=true` because NATS instantly drops subscriptions from dead nodes.

**Tests hypothesis H5:** rapid node ID churn does not prevent call delivery.

#### A2: Broadcast Under Listener Churn

1. Sends **broadcast #1** with all churn listeners alive (10 expected receivers)
2. Restarts `churn-listener-1`, sends **broadcast #2** during the restart (listener-1 is in a grace period — its receipt is optional)
3. Restarts `churn-listener-2` and `churn-listener-3` simultaneously, sends **broadcast #3** during their restart
4. Waits for all listeners to recover, sends **broadcast #4** as a post-stabilization check
5. Reads broadcast receipt files from all listeners and matches them to each broadcast by correlation ID

The test distinguishes between **expected** receivers (nodes known to be alive) and **optional** receivers (nodes that are in the middle of restarting). Missing an expected receiver is a failure; missing an optional receiver is fine.

**Tests hypothesis H6:** broadcast fanout works during listener churn.

#### A3: Rapid Restart Cadence

This is the most aggressive stress test. It runs 3 rounds:

- **Round 1:** Restarts the same worker (`churn-worker-1`) **4 times in rapid succession**, sending 8 calls between each restart. This tests whether extremely fast identity changes break routing.
- **Round 2:** **Alternates restarts** between `churn-worker-1` and `churn-worker-2` (3 iterations), sending 8 calls between each. This tests concurrent identity changes across multiple services.
- **Round 3:** Restarts **all 3 churn workers simultaneously**, then immediately sends 15 calls. This is the worst case — 3 workers die and restart at the same time.

After all rounds, sends 15 more calls to verify recovery.

Total: ~86 calls across all rounds.

#### A4: Stale-ID Evidence Collection

Not a test itself — it collects and reports evidence of node ID transitions. After all the restarts in A1-A3, this records:

- **Dead (obsolete) node IDs:** IDs that were killed and never reappeared
- **Live (current) node IDs:** IDs that are currently active
- **Transitions:** which old ID was replaced by which new ID

This data proves that containers genuinely got new identities. If calls continued working despite 13+ identity changes, that's strong evidence that NATS routing (not the stale registry) is driving delivery.

### Phase 3: Scale / Transport-Load Stress Test (H7-H8, B1-B4)

The scale test pushes the system to a larger fleet (default 10 workers + 10 listeners = 20 additional containers) and measures how churn affects latency at scale.

#### B1: Fleet Launch

Starts the scale fleet using `docker compose up --scale scale-worker=10 --scale scale-listener=10`. Waits for at least 80% of the target connections to appear in NATS monitoring before proceeding.

#### B2: Scale Churn (Kill/Restore Cycles)

Runs a 5-phase churn pattern:

1. **Kill ~40% of workers** (4 out of 10) — randomly selected, killed via `docker kill`
2. **Restore all workers** — `docker compose up` brings the fleet back to 10
3. **Kill ~40% of listeners** (4 out of 10) — randomly selected
4. **Restore and kill different workers** — brings everything back, then kills a different ~30% (3 out of 10) of workers
5. **Full restore** — bring everything back to 10+10

During this whole process, calls and broadcasts are being measured.

#### B3: Latency Measurement

Measures call latency at three points:

- **Before churn:** 30 calls with 20ms delay between each — establishes the baseline latency (typically 4-5ms avg)
- **During churn:** 40 calls total across the kill/restore phases — captures the impact of dead nodes
- **After churn:** 30 calls after full restore — confirms latency returns to normal

Reports min, max, avg, p50, and p95 for each phase.

**This is where the `disableBalancer` setting makes the biggest measurable difference.** With the balancer disabled, during-churn latency stays low (4ms avg). With the balancer enabled, some calls hit dead nodes and wait the full 15-second timeout before retrying.

**Tests hypothesis H7:** delivery continues at scale with limited delay.

#### B4: Transport Load Evidence

Takes NATS monitoring snapshots at 4 points during the scale test:
- `scale-initial` — full fleet running
- `scale-after-kill-1` — after killing ~40% of workers
- `scale-mid-churn` — during the kill/restore cycles
- `scale-final` — after full restore

The snapshot data (connection counts, subscription counts) proves that nodes actually died and came back, ruling out the possibility that the test simply didn't kill anything.

**Tests hypothesis H8:** NATS subscribers (not old Moleculer node IDs) drive delivery.

---

## What is "Churn"?

"Churn" refers to **rapid, repeated container restarts** that change node identities. In container orchestrators like Kubernetes, rolling deployments, auto-scaling events, or OOM kills all cause churn. Each restart produces a new container with a new identity. The test simulates this by:

1. Starting a container with a dynamic node ID (e.g., `cw1-1710000000000-a1b2c3`)
2. Killing it with `docker restart` or `docker kill`
3. The new container starts with a completely new node ID (e.g., `cw1-1710000005000-x9y8z7`)

From Moleculer's perspective, the old node disappeared and a brand new node appeared. Any node that still has the old ID in its registry is holding a **stale entry**.

## What is the "Scale" Test?

The scale test creates a **larger fleet** (20 nodes by default) and runs kill/restore cycles against it. The purpose is twofold:

1. **More realistic fleet sizes** — production systems often have many replicas
2. **Amplified stale-registry effect** — with more nodes, there are more possible stale entries when churn happens, making the latency difference between `disableBalancer=true` and `false` more dramatic

## Control Mode (`--disable-false`)

Running with `--disable-false` sets `disableBalancer=false`, which enables Moleculer's internal balancer. This is the **control experiment** — it runs the exact same tests but with the balancer enabled, so you can compare results.

In control mode, the test harness has **expected outcomes** for each hypothesis. Several hypotheses are expected to FAIL (e.g., H1, H3, H5), because with the balancer enabled:
- Calls go through per-node routing (`REQ.<nodeId>`), not queue groups
- Local calls are short-circuited, not sent through the transporter
- Stale registry entries cause timeouts during churn

The test passes in control mode if the **expected failures actually fail** — confirming that the `disableBalancer` flag is the variable driving the observed differences.

---

## Hypotheses Reference

### Baseline Hypotheses (H1-H4)

| ID | Hypothesis | What Would Prove It |
|----|-----------|---------------------|
| H1 | `broker.call()` is routed over NATS using balanced action subjects / queue groups | Multiple workers handle calls; `REQB.*` subjects visible in NATS |
| H2 | `broker.broadcast()` fans out via NATS pub/sub to all service instances | All 6 listeners receive every broadcast |
| H3 | Routing does NOT depend on Moleculer's per-node request routing | Action-level subjects outnumber node-targeted subjects in NATS |
| H4 | Local calls are forced through the transporter (not short-circuited) | Hybrid node distributes calls to remote workers, not just itself |

### Churn / Stale-Registry Hypotheses (H5-H6)

| ID | Hypothesis | What Would Prove It |
|----|-----------|---------------------|
| H5 | Rapid node ID churn does not prevent `call` delivery | >85% success rate during churn; calls reach new node IDs |
| H6 | Rapid node ID churn does not prevent `broadcast` fanout | Expected listeners receive broadcasts during churn |

### Scale / Transport-Load Hypotheses (H7-H8)

| ID | Hypothesis | What Would Prove It |
|----|-----------|---------------------|
| H7 | Under large-scale churn, message delivery continues with bounded delay | Call success rate remains high; latency increase is bounded |
| H8 | Current NATS subscribers are more predictive of delivery than old node IDs | NATS snapshots show connection changes matching actual node churn |

---

## Output Structure

```
output/
├── report.md                          Final human-readable report
├── report.json                        Machine-readable report
├── broadcast-evidence-collected.json  Baseline broadcast receipts
├── node-ready-*.json                  Node readiness files (one per container)
├── broadcast-receipt-*.jsonl          Per-node broadcast receipts (JSONL format)
├── baseline/
│   ├── nats-subsz.json                NATS subscriptions snapshot
│   ├── nats-connz.json                NATS connections snapshot
│   ├── nats-varz.json                 NATS server vars
│   └── nats-analysis.json             Parsed subscription analysis
├── churn/
│   ├── call-results.json              Call test results during churn (A1)
│   ├── broadcast-results.json         Broadcast results during churn (A2)
│   ├── rapid-restart-results.json     Rapid restart test results (A3)
│   ├── stale-id-evidence.json         Node ID transition evidence (A4)
│   ├── timeline.json                  Churn event timeline with wave data
│   └── nats-snapshot-*.json           NATS snapshots: churn-pre, churn-mid, churn-post
└── scale/
    ├── latency-before.json            Latency measurements before churn (B3)
    ├── latency-during.json            Latency measurements during churn (B3)
    ├── latency-after.json             Latency measurements after churn (B3)
    ├── broadcast-delivery.json        Broadcast delivery metrics
    └── nats-snapshot-*.json           NATS snapshots: scale-initial, scale-after-kill-1,
                                         scale-mid-churn, scale-final
```

## How to Interpret the Report

### Hypothesis Results

Each hypothesis gets a **PASS/FAIL** with a confidence level:
- **PASS (high)**: Strong quantitative evidence supporting the hypothesis
- **PASS (medium)**: Reasonable evidence, with caveats noted
- **FAIL**: Evidence contradicts the hypothesis

### Churn Test: Key Metrics

| Metric | Good Value | Concerning Value |
|--------|-----------|-----------------|
| Call success rate | >95% | <85% |
| Distinct handler node IDs | Increases across restart waves | Stays the same (no new nodes receiving calls) |
| Zombie calls | 0 | Any (responses from dead node IDs) |
| Max latency (A1) | <50ms | >1000ms (suggests retries/timeouts) |
| Max latency (A3) | <100ms | >500ms (suggests stale routing) |

### Scale Test: Key Metrics

| Metric | Good (`disableBalancer=true`) | Concerning (`disableBalancer=false`) |
|--------|------|------|
| Before-churn latency | ~4-5ms avg | ~4-5ms avg (same — no churn yet) |
| During-churn latency | ~4-5ms avg | ~2000ms+ avg (timeouts to dead nodes) |
| During-churn p95 | <15ms | >15000ms (hitting the requestTimeout) |
| After-churn latency | ~4-5ms avg | ~4-5ms avg (same — churn is over) |
| NATS subscription count | Higher (has REQB subjects) | Lower (no queue-group subjects) |

### Key Caveat

This suite cannot directly inspect Moleculer's internal registry state. Instead, it **infers** stale-registry behavior by showing that:
1. Node IDs change on restart (verified via NATS monitoring and response data)
2. Calls/broadcasts continue working during those transitions
3. NATS subscriptions reflect current (not stale) subscribers
4. Latency patterns match the expected behavior for each routing mode

---

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `SKIP_CHURN` | `false` | Skip churn test suite (Phase 2) |
| `SKIP_SCALE` | `false` | Skip scale test suite (Phase 3) |
| `SCALE_WORKERS` | `10` | Number of scale worker replicas |
| `SCALE_LISTENERS` | `10` | Number of scale listener replicas |

### Moleculer Config (all nodes)

| Setting | Value |
|---------|-------|
| Transporter | NATS |
| `disableBalancer` | `true` (or `false` with `--disable-false`) |
| Namespace | `demo` |
| Request timeout | 15,000ms |
| Retry policy | 3 retries, 500ms initial delay, 3000ms max delay |

## Requirements

- Docker + Docker Compose v2
- Node.js 20+
- ~4GB RAM for scale tests (adjustable via `SCALE_WORKERS`/`SCALE_LISTENERS`)

---

## Appendix: Comparative Analysis — `disableBalancer=true` vs `false`

This section documents a side-by-side experiment comparing both modes. The test was run on the same machine, back-to-back, using the shell's built-in `time` command to measure wall-clock duration.

### How the Comparison Was Run

```bash
# Run 1: default mode (disableBalancer=true, NATS-driven routing)
time ./scripts/run-all.sh 2>&1 | tee /tmp/run-all-no-flag.log

# Save the report before it gets overwritten
cp output/report.md /tmp/report-no-flag.md

# Run 2: control mode (disableBalancer=false, Moleculer balancer active)
time ./scripts/run-all.sh --disable-false 2>&1 | tee /tmp/run-all-disable-false.log
```

The `time` command wraps the entire script and prints wall-clock, user, and system time at the end. The `tee` command saves all output (including Moleculer WARN logs for retries and timeouts) to a file for post-hoc analysis while still printing to the terminal. After each run, `output/report.md` and `output/report.json` contain the full structured results.

The log files were then searched for retry and timeout evidence:

```bash
# Count retry warnings
grep -c -i "retry\|retrying\|retried" /tmp/run-all-no-flag.log
grep -c -i "retry\|retrying\|retried" /tmp/run-all-disable-false.log

# Find timeout warnings
grep -i "timeout\|timed out" /tmp/run-all-disable-false.log
```

The latency, duration, and subscription count tables below were extracted from the `output/report.md` generated by each run, and from the NATS monitoring snapshots.

### Wall-Clock Duration

| Run | Mode | Total Time |
|-----|------|------------|
| Run 1 | `disableBalancer=true` (no flag) | **2 min 40s** |
| Run 2 | `disableBalancer=false` (`--disable-false`) | **4 min 04s** — 52% slower |

The extra ~84 seconds in Run 2 come almost entirely from the scale test phase, where timeouts to dead nodes add 15 seconds each.

### Retries and Timeouts

| Metric | `disableBalancer=true` | `disableBalancer=false` |
|--------|----------------------|------------------------|
| Retry warnings in log | **0** | **8** |
| Timeout warnings in log | **0** | **4** (15s each) |

With `disableBalancer=false`, the logs showed explicit Moleculer warnings like:

```
WARN  BROKER: Request 'workers.process' is timed out.
        { nodeID: 'sw-...-4gu0tj', timeout: 15000 }
WARN  BROKER: Retry to call 'workers.process' action after 500 ms...
        { attempts: 1 }
```

Each timeout means a request was sent to a node-specific NATS subject (`MOL-demo.REQ.<nodeId>`) where no one was listening, because the target node had been killed but Moleculer's registry hadn't purged it yet. The request waited the full 15 seconds before timing out and triggering a retry.

With `disableBalancer=true`, there were **zero** retry or timeout warnings — NATS queue groups instantly routed around dead nodes.

### Churn Test Latency (A1: Call Routing Under Churn)

| Metric | `disableBalancer=true` | `disableBalancer=false` |
|--------|----------------------|------------------------|
| Total calls | 85 | 85 |
| Success rate | 100% | 100% |
| Avg latency | 4ms | 4ms |
| p95 latency | 7ms | 7ms |
| **Max latency** | **10ms** | **12ms** |

In the churn test (3 workers being restarted), both modes performed similarly because the churn workers are a subset of all available workers — the static baseline workers (`worker-a-1`, `worker-a-2`, `hybrid-1`) were always available to handle calls even if a churn worker was down.

### Rapid Restart Latency (A3: Aggressive Churn)

| Metric | `disableBalancer=true` | `disableBalancer=false` |
|--------|----------------------|------------------------|
| Total calls | 86 | 86 |
| Success rate | 100% | 100% |
| Avg latency | 3ms | 15ms |
| p95 latency | 7ms | 7ms |
| **Max latency** | **10ms** | **506ms** |

The max latency difference (10ms vs 506ms) reveals a single retry cycle. With `disableBalancer=false`, at least one call during rapid restarts was routed to a dead node, timed out partially, and retried — taking ~500ms instead of the normal ~3ms.

### Scale Test Latency (B3: 10+10 Fleet with Kill/Restore Cycles)

This is where the difference is most dramatic:

| Phase | `disableBalancer=true` | `disableBalancer=false` |
|-------|----------------------|------------------------|
| **Before churn** | avg=5ms, p95=8ms, max=8ms | avg=4ms, p95=6ms, max=8ms |
| **During churn** | avg=4ms, p95=11ms, max=12ms | avg=2111ms, p95=15508ms, max=26775ms |
| **After churn** | avg=4ms, p95=7ms, max=9ms | avg=4ms, p95=6ms, max=9ms |

Key observations:

- **Before and after churn:** both modes perform identically (~4-5ms). There is no inherent overhead difference between the modes when all nodes are healthy.
- **During churn with `disableBalancer=true`:** latency barely changes (4ms avg → 4ms avg). NATS removes dead subscriptions instantly, so calls never reach a dead node.
- **During churn with `disableBalancer=false`:** avg latency explodes to **2,111ms** (a 528x increase) and p95 hits **15,508ms** (matching the 15-second `requestTimeout`). Some calls wait the full timeout and then retry, while others happen to pick a live node and complete fast — which is why the p50 stays at 5ms but the p95/max are enormous.

### Scale Test Duration

| Phase | `disableBalancer=true` | `disableBalancer=false` |
|-------|----------------------|------------------------|
| Scale test (start to finish) | **~39 seconds** | **~124 seconds** — 3.2x longer |

The scale test is 3.2x slower with the balancer enabled because 4 requests hit 15-second timeouts (4 × 15s = 60s of pure waiting), plus retry delays.

### NATS Subscription Counts

| Phase | `disableBalancer=true` | `disableBalancer=false` |
|-------|----------------------|------------------------|
| Churn: subscriptions | **441** | **267** |
| Scale: subscriptions (initial) | **726** | **423** |

With `disableBalancer=true`, Moleculer creates additional `REQB.*` subjects with queue groups for each action. This is the mechanism that enables NATS-level load balancing. With `disableBalancer=false`, those queue-group subjects don't exist — Moleculer uses `REQ.<nodeId>` subjects instead (node-targeted), resulting in fewer total subscriptions.

The difference (726 - 423 = 303 additional subscriptions at scale) directly reflects the queue-group subjects that are the backbone of NATS-driven routing.

### Why the Control Experiment Has "Unexpected Results"

The control experiment expected hypotheses H1, H3, H5, H7, and H8 to **FAIL** with `disableBalancer=false`. However, they all **PASSED**. This happened because:

1. **H1 (call distribution):** Even with the internal balancer, Moleculer still distributes calls across workers (it uses a round-robin algorithm internally). The calls are distributed — just via a different mechanism.
2. **H3 (no per-node routing):** The test checks for action-level NATS subjects, and Moleculer still publishes to action subjects (just not queue-grouped ones), so the evidence is ambiguous.
3. **H5, H7 (churn resilience):** The retry policy (`retries: 3, delay: 500ms`) means calls eventually succeed after timeouts — they don't fail outright. The test checks success rate, not latency, so 100% success with terrible latency still counts as a PASS.
4. **H8 (NATS subscribers drive delivery):** NATS monitoring still shows subscriber changes during churn regardless of the balancer setting.

The real observable difference is not pass/fail but **latency and retries**. The calls still succeed with `disableBalancer=false` — they just take orders of magnitude longer during churn because of timeout-retry cycles. This is documented in the latency tables above.

### Summary

| Aspect | `disableBalancer=true` | `disableBalancer=false` |
|--------|----------------------|------------------------|
| Routing mechanism | NATS queue groups | Moleculer internal registry |
| Dead node handling | Instant (subscription drop) | 15s timeout + retry |
| Retries during churn | 0 | 8+ |
| During-churn latency | ~4ms avg | ~2100ms avg |
| Total script runtime | 2m 40s | 4m 04s |
| NATS subscriptions | Higher (queue-group subjects) | Lower (node-targeted subjects) |
| Call success rate | 100% | 100% (but via retries) |
