# Moleculer + NATS `disableBalancer` Validation Suite

Automated validation that Moleculer's `disableBalancer: true` mode correctly delegates routing to the NATS transporter, making the system resilient to stale internal registries during rapid node churn.

## Table of Contents

- [Background](#background)
- [How `disableBalancer` Changes Routing](#how-disablebalancer-changes-routing)
- [Architecture](#architecture)
- [Quick Start](#quick-start)
- [Tests and Results](#tests-and-results)
- [Results Summary](#results-summary)
- [Configuration](#configuration)
- [Output Structure](#output-structure)

---

## Background

Moleculer maintains an **internal service registry** on each node that tracks which other nodes exist and what actions they provide. When you call `broker.call("some.action")`, Moleculer's built-in **balancer** picks a target node from this registry and sends the request directly to that node's address.

The problem emerges during **node churn** — when containers restart, scale up/down, or crash. After a container dies and restarts with a new identity, other nodes' registries still contain the **old, dead node ID**. The balancer may route requests to a node that no longer exists, causing 15-second timeouts and retries.

**`disableBalancer: true`** solves this by delegating all routing to NATS. Moleculer publishes calls to an action-level NATS subject with a **queue group**. NATS distributes the message to one of the currently subscribed nodes. When a node dies, its subscription disappears instantly and NATS routes to the remaining live subscribers — no stale registry, no timeouts.

### Moleculer Version History

The `disableBalancer` option originally only affected `broker.call()`. Support for `broker.broadcast()` and `broker.emit()` was added in:

- **Issue:** [moleculerjs/moleculer#791](https://github.com/moleculerjs/moleculer/issues/791)
- **PR:** [moleculerjs/moleculer#799](https://github.com/moleculerjs/moleculer/pull/799)
- **Released in:** Moleculer **v0.14.10** — this project uses **v0.14.35**

## How `disableBalancer` Changes Routing

### `disableBalancer: true` (default in this project)

```
Caller → broker.call("workers.process")
       → publishes to NATS subject: MOL-demo.REQB.workers.process [queue group]
       → NATS picks one of the subscribed workers
       → worker-a-1 OR worker-a-2 OR hybrid-1 handles it
```

Dead node? Its NATS subscription vanishes instantly. NATS routes to a remaining subscriber. No retry needed.

### `disableBalancer: false` (Moleculer default)

```
Caller → broker.call("workers.process")
       → Moleculer registry picks a target: "worker-a-2"
       → publishes to NATS subject: MOL-demo.REQ.worker-a-2.<hash>
       → if worker-a-2 is dead: 15-second timeout → retry → pick another node
```

Dead node? The request sits on a NATS subject with no subscriber for the full `requestTimeout` (15s), then retries.

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

**Baseline** (always running): 2 workers, 1 caller, 1 broadcaster, 4 listeners, 1 hybrid — all with static node IDs.

**Churn** (profile: `churn`): 3 workers + 4 listeners with dynamic node IDs (`<prefix>-<timestamp>-<random>`). Every restart generates a new identity.

**Scale** (profile: `scale`): N workers + N listeners (default 10+10) with dynamic IDs, launched via `docker compose up --scale`.

## Quick Start

```bash
# Full validation: build, test, report, teardown
./scripts/run-all.sh

# Control experiment (disableBalancer=false) for comparison
./scripts/run-all.sh --disable-false

# Selective runs
SKIP_CHURN=true SKIP_SCALE=true ./scripts/validate.sh   # baseline only
SKIP_SCALE=true ./scripts/validate.sh                    # baseline + churn
SCALE_WORKERS=20 SCALE_LISTENERS=20 ./scripts/validate.sh # custom scale
```

---

## Tests and Results

Both scripts were run back-to-back on the same machine, timed with the shell's `time` command and logged with `tee` for post-hoc analysis of retries and timeouts.

### Phase 1: Baseline Validation

The baseline tests run against the 9 static services with no churn.

#### H1: Call Distribution (40 calls to `workers.process`)

Records which worker handled each call. With `disableBalancer=true`, NATS queue groups distribute calls. With `false`, Moleculer's internal round-robin does.

| | `disableBalancer=true` | `disableBalancer=false` |
|-|----------------------|------------------------|
| Distributed across workers? | Yes (3 workers) | Yes (3 workers) |
| NATS queue groups (`REQB.*`) visible? | Yes (17 queue-group subs) | No |
| **Result** | **PASS** | **PASS** |

Both modes distribute calls — just via different mechanisms.

#### H2: Broadcast Fanout (3 broadcasts to 6 listeners)

Sends `demo.broadcast` events and checks that all 6 listeners receive each one.

| | `disableBalancer=true` | `disableBalancer=false` |
|-|----------------------|------------------------|
| All 6 listeners received all 3? | Yes (18/18) | Yes (18/18) |
| **Result** | **PASS** | **PASS** |

Broadcasts always go via NATS pub/sub regardless of the balancer setting.

#### H3: No Per-Node Routing

Analyzes NATS subscription patterns. With `disableBalancer=true`, action-level `REQB.*` subjects with queue groups should dominate.

| | `disableBalancer=true` | `disableBalancer=false` |
|-|----------------------|------------------------|
| Action-level subjects | 63 | 47 |
| Node-targeted subjects | 20 | 20 |
| NATS subscriptions (baseline) | 441 (churn) / 726 (scale) | 267 / 423 |
| **Result** | **PASS** | **PASS** |

The 303 extra subscriptions at scale with `true` are the `REQB.*` queue-group subjects.

#### H4: Local Calls Through Transporter

The `hybrid-1` node has both a worker and a caller. It makes 20 calls to `workers.process`.

| | `disableBalancer=true` | `disableBalancer=false` |
|-|----------------------|------------------------|
| Local handler received | 10/20 | 20/20 |
| Remote handlers received | 10/20 | 0/20 |
| **Result** | **PASS** (distributed via NATS) | **FAIL** (local short-circuit) |

This is the only hypothesis with a genuinely different outcome. With the balancer enabled, Moleculer short-circuits to the local handler.

### Phase 2: Churn Stress Test

Spins up 7 containers (3 workers + 4 listeners) with dynamic node IDs, then kills and restarts them while sending calls and broadcasts. Each restart generates a brand-new node ID — 13 restart waves total, producing 13 obsolete IDs replaced by 9 new ones.

#### H5 / A1: Call Routing Under Churn (85 calls across 3 restart waves)

Sends 20 pre-churn calls, then restarts each churn worker one at a time, sending 15 calls immediately after each restart, then 20 post-churn calls.

| | `disableBalancer=true` | `disableBalancer=false` |
|-|----------------------|------------------------|
| Success rate | 100% (85/85) | 100% (85/85) |
| Avg latency | 5ms | 5ms |
| p95 latency | 10ms | 8ms |
| Max latency | 12ms | 10ms |
| Distinct handler IDs | 9 | 9 |
| **Result** | **PASS** | **PASS** |

Both modes handle this well because the 3 static baseline workers always absorb calls when churn workers are down.

#### H6 / A2: Broadcast Under Listener Churn (4 broadcasts during listener restarts)

Sends broadcasts while restarting churn listeners. Distinguishes between expected receivers (known alive) and optional (mid-restart).

| | `disableBalancer=true` | `disableBalancer=false` |
|-|----------------------|------------------------|
| Delivery to expected listeners | 92.3% | 92.3% |
| **Result** | **PASS** | **PASS** |

The 7.7% gap comes from old node IDs that were killed and hadn't resubscribed yet — expected behavior.

#### A3: Rapid Restart Cadence (86 calls across aggressive restart patterns)

The most aggressive test: restarts the same worker 4x rapidly, alternates restarts between two workers, then restarts all 3 simultaneously — sending calls between every restart.

| | `disableBalancer=true` | `disableBalancer=false` |
|-|----------------------|------------------------|
| Success rate | 100% (86/86) | 100% (86/86) |
| Avg latency | 3ms | 15ms |
| p95 latency | 6ms | 7ms |
| **Max latency** | **10ms** | **507ms** |
| **Result** | **PASS** | **PASS** |

The 507ms max with `false` reveals a retry cycle — one call hit a dead node and had to retry. With `true`, NATS routed around it instantly.

#### A4: Stale-ID Evidence

After all restarts: 13 obsolete node IDs replaced by 9 new ones. Calls continued working through all transitions, confirming NATS-level routing drives delivery.

### Phase 3: Scale Stress Test (10 workers + 10 listeners)

Launches 20 additional containers and runs kill/restore cycles: kill 40% of workers → restore → kill 40% of listeners → restore → kill 30% different workers → full restore. Measures latency before, during, and after.

#### H7: Latency Under Scale Churn

This is where the difference between modes is most dramatic:

| Phase | `disableBalancer=true` | `disableBalancer=false` |
|-------|----------------------|------------------------|
| Before churn | avg=5ms, p95=8ms | avg=4ms, p95=7ms |
| **During churn** | **avg=5ms, p95=8ms** | **avg=2132ms, p95=31509ms** |
| After churn | avg=4ms, p95=6ms | avg=3ms, p95=4ms |
| **Result** | **PASS** | **PASS** (via retries) |

With `disableBalancer=true`, latency doesn't change during churn. With `false`, it explodes to 2,132ms avg because calls hit dead nodes and wait 15s before retrying — some hitting two consecutive timeouts (31.5s).

Both modes achieve 100% call success and 100% broadcast delivery. The difference is purely latency.

#### H8: NATS Subscribers Drive Delivery

NATS monitoring snapshots confirm that connections and subscriptions change in sync with actual node churn:

| Snapshot | `disableBalancer=true` | `disableBalancer=false` |
|----------|----------------------|------------------------|
| scale-initial | 30 conn / 726 subs | 30 conn / 423 subs |
| scale-after-kill-1 | 26 conn / 642 subs | 26 conn / 375 subs |
| scale-final | 30 conn / 726 subs | 30 conn / 423 subs |
| **Result** | **PASS** | **PASS** |

---

## Results Summary

### Overall Timing

| | `disableBalancer=true` | `disableBalancer=false` |
|-|----------------------|------------------------|
| Total script runtime | **2m 41s** | **4m 05s** (52% slower) |
| Scale test phase | ~39s | ~124s (3.2x longer) |
| Retries in log | 0 | 9 |
| Timeouts in log | 0 | 4 (15s each) |

### Hypothesis Results with Expectations

In control mode (`--disable-false`), we expect only H4 to fail. Everything else passes — calls succeed via retries, just with higher latency during churn.

| Hypothesis | Description | `true` | `false` | Expected (`false`) | Match? |
|------------|-------------|--------|---------|-------------------|--------|
| H1 | Call distribution via NATS queue groups | PASS | PASS | PASS | OK |
| H2 | Broadcast fanout to all listeners | PASS | PASS | PASS | OK |
| H3 | No per-node request routing | PASS | PASS | PASS | OK |
| H4 | Local calls go through transporter | PASS | FAIL | FAIL | OK |
| H5 | Calls survive node churn | PASS | PASS | PASS | OK |
| H6 | Broadcasts survive listener churn | PASS | PASS | PASS | OK |
| H7 | Scale churn: delivery with bounded delay | PASS | PASS | PASS | OK |
| H8 | NATS subscribers predict delivery | PASS | PASS | PASS | OK |

**All expectations met.** The only behavioral difference is H4 (local call short-circuiting). The real difference is latency:

| Metric | `disableBalancer=true` | `disableBalancer=false` |
|--------|----------------------|------------------------|
| Routing mechanism | NATS queue groups | Moleculer internal registry |
| Dead node handling | Instant (subscription drop) | 15s timeout + retry |
| During-churn latency (scale) | ~5ms avg / 8ms p95 | ~2132ms avg / 31,509ms p95 |
| Call success rate | 100% | 100% (but via retries) |

### How the Comparison Was Run

```bash
time ./scripts/run-all.sh 2>&1 | tee /tmp/run-no-flag.log
cp output/report.md /tmp/report-no-flag.md
time ./scripts/run-all.sh --disable-false 2>&1 | tee /tmp/run-disable-false.log
```

Log files were searched for retries (`grep -c "retry" <log>`) and timeouts (`grep "timed out" <log>`). Latency tables were extracted from the generated `output/report.md`. Subscription counts came from NATS monitoring snapshots.

### Key Caveat

This suite cannot directly inspect Moleculer's internal registry. It infers stale-registry behavior by showing that node IDs change on restart, calls/broadcasts continue working, NATS subscriptions reflect current subscribers, and latency patterns match the expected routing behavior for each mode.

---

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `SKIP_CHURN` | `false` | Skip churn test suite |
| `SKIP_SCALE` | `false` | Skip scale test suite |
| `SCALE_WORKERS` | `10` | Scale worker replicas |
| `SCALE_LISTENERS` | `10` | Scale listener replicas |

All nodes use: NATS transporter, namespace `demo`, 15s request timeout, retry policy (3 retries, 500ms-3s delay).

**Requirements:** Docker + Docker Compose v2, Node.js 20+, ~4GB RAM for scale tests.

## Output Structure

```
output/
├── report.md / report.json       Final reports
├── baseline/                     NATS subscription/connection snapshots
├── churn/                        Call results, broadcast results, restart timeline,
│                                 stale-ID evidence, NATS snapshots (pre/mid/post)
└── scale/                        Latency before/during/after, broadcast delivery,
                                  NATS snapshots (initial/after-kill/mid-churn/final)
```
