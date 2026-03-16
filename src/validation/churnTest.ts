import { v4 as uuidv4 } from "uuid";
import {
  ChurnTestSuiteResult,
  ChurnCallResult,
  ChurnBroadcastResult,
  ChurnBroadcastSingleResult,
  ChurnWave,
  NodeIdTimelineEntry,
  NatsSnapshot,
  StaleIdEvidence,
  LatencyStats,
  LatencyMeasurement,
  CallEvidence,
  CallTestPayload,
  BroadcastTestPayload,
} from "../common/types";
import {
  startChurnServices,
  stopChurnServices,
  restartService,
  discoverNodeIdsByPrefix,
  discoverNodeIdsFromNats,
  waitForNatsConnections,
  clearReadinessFiles,
  clearBroadcastReceiptFiles,
  readBroadcastReceiptFiles,
  readReadinessFiles,
  takeNatsSnapshot,
  sleep,
} from "./dockerOrchestrator";

const CHURN_WORKER_SERVICES = ["churn-worker-1", "churn-worker-2", "churn-worker-3"];
const CHURN_WORKER_PREFIXES = ["cw1", "cw2", "cw3"];
const CHURN_LISTENER_SERVICES = ["churn-listener-1", "churn-listener-2", "churn-listener-3", "churn-listener-4"];
const CHURN_LISTENER_PREFIXES = ["cl1", "cl2", "cl3", "cl4"];
const STATIC_LISTENER_IDS = [
  "listener-b-1", "listener-c-1", "listener-d-1", "listener-e-1",
  "broadcaster-1", "hybrid-1",
];

export function computeLatencyStats(measurements: LatencyMeasurement[]): LatencyStats {
  const successful = measurements.filter((m) => m.success);
  const latencies = successful.map((m) => m.latencyMs).sort((a, b) => a - b);

  if (latencies.length === 0) {
    return {
      count: measurements.length,
      successCount: 0,
      failureCount: measurements.length,
      successRate: 0,
      minMs: 0, maxMs: 0, avgMs: 0, p50Ms: 0, p95Ms: 0,
    };
  }

  return {
    count: measurements.length,
    successCount: successful.length,
    failureCount: measurements.length - successful.length,
    successRate: successful.length / measurements.length,
    minMs: latencies[0],
    maxMs: latencies[latencies.length - 1],
    avgMs: Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length),
    p50Ms: latencies[Math.floor(latencies.length * 0.5)],
    p95Ms: latencies[Math.floor(latencies.length * 0.95)],
  };
}

async function sendCalls(
  broker: any,
  count: number,
  phase: string,
  delayMs = 50,
): Promise<{ results: CallEvidence[]; measurements: LatencyMeasurement[]; failures: any[] }> {
  const results: CallEvidence[] = [];
  const measurements: LatencyMeasurement[] = [];
  const failures: any[] = [];

  for (let i = 0; i < count; i++) {
    const correlationId = uuidv4();
    const start = Date.now();
    try {
      const result = await broker.call("workers.process", {
        correlationId,
        sequenceNumber: i,
        sentBy: broker.nodeID,
        sentAt: new Date().toISOString(),
      } as CallTestPayload);
      const latency = Date.now() - start;
      results.push(result);
      measurements.push({
        phase,
        latencyMs: latency,
        success: true,
        handlerNodeId: result.handlerNodeId,
        timestamp: new Date().toISOString(),
      });
    } catch (err: any) {
      measurements.push({
        phase,
        latencyMs: Date.now() - start,
        success: false,
        error: err.message,
        timestamp: new Date().toISOString(),
      });
      failures.push({
        correlationId,
        error: err.message,
        timestamp: new Date().toISOString(),
        phase,
      });
    }
    if (delayMs > 0) await sleep(delayMs);
  }

  return { results, measurements, failures };
}

async function sendBroadcast(
  broker: any,
  correlationId: string,
): Promise<void> {
  const payload: BroadcastTestPayload = {
    correlationId,
    sentBy: broker.nodeID,
    sentAt: new Date().toISOString(),
    message: `churn-broadcast-${correlationId.slice(0, 8)}`,
  };
  broker.broadcast("demo.broadcast", payload);
}

async function discoverAllChurnNodeIds(): Promise<{ workers: string[]; listeners: string[] }> {
  const [workers, listeners] = await Promise.all([
    discoverNodeIdsFromNats(CHURN_WORKER_PREFIXES),
    discoverNodeIdsFromNats(CHURN_LISTENER_PREFIXES),
  ]);
  return { workers, listeners };
}

// ────────────────────────────────────────────────────────────
// A1: Call routing under node churn
// ────────────────────────────────────────────────────────────

async function runCallChurnTest(
  broker: any,
  waves: ChurnWave[],
  timeline: NodeIdTimelineEntry[],
): Promise<ChurnCallResult> {
  console.log("[ChurnTest:A1] Call routing under node churn");

  const allResults: CallEvidence[] = [];
  const allMeasurements: LatencyMeasurement[] = [];
  const allFailures: any[] = [];
  const allDeadNodeIds = new Set<string>();

  // Pre-churn: send 20 calls to establish baseline
  console.log("[ChurnTest:A1] Sending pre-churn calls...");
  const pre = await sendCalls(broker, 20, "pre-churn", 30);
  allResults.push(...pre.results);
  allMeasurements.push(...pre.measurements);
  allFailures.push(...pre.failures);

  // 3 restart waves, each targets a different churn worker
  for (let wave = 0; wave < 3; wave++) {
    const targetIdx = wave % CHURN_WORKER_SERVICES.length;
    const target = CHURN_WORKER_SERVICES[targetIdx];
    const prefix = CHURN_WORKER_PREFIXES[targetIdx];

    const oldIds = await discoverNodeIdsByPrefix(prefix);
    oldIds.forEach((id) => allDeadNodeIds.add(id));

    const restartStart = Date.now();
    restartService(target);
    const restartDuration = Date.now() - restartStart;

    waves.push({
      waveNumber: waves.length + 1,
      serviceName: target,
      action: "restart",
      timestamp: new Date().toISOString(),
      durationMs: restartDuration,
      oldNodeIds: oldIds,
      newNodeIds: [],
    });

    // Send calls IMMEDIATELY during/after restart (15 calls, fast)
    console.log(`[ChurnTest:A1] Wave ${wave + 1}: Sending calls during/after restart of ${target}...`);
    const during = await sendCalls(broker, 15, `during-churn-wave-${wave + 1}`, 80);
    allResults.push(...during.results);
    allMeasurements.push(...during.measurements);
    allFailures.push(...during.failures);

    // Wait for new node, discover new IDs
    await sleep(4000);
    const newIds = await discoverNodeIdsByPrefix(prefix);
    waves[waves.length - 1].newNodeIds = newIds;

    timeline.push({
      timestamp: new Date().toISOString(),
      event: `post-worker-restart-wave-${wave + 1}`,
      activeNodeIds: newIds,
    });
  }

  // Post-churn: send 20 more calls
  console.log("[ChurnTest:A1] Sending post-churn calls...");
  await sleep(2000);
  const post = await sendCalls(broker, 20, "post-churn", 30);
  allResults.push(...post.results);
  allMeasurements.push(...post.measurements);
  allFailures.push(...post.failures);

  // Check for zombie calls (responses from dead node IDs)
  const liveNodeIds = new Set(
    allResults.map((r) => r.handlerNodeId),
  );
  const zombieCalls = allResults.filter((r) => allDeadNodeIds.has(r.handlerNodeId));

  const distribution: Record<string, number> = {};
  for (const r of allResults) {
    distribution[r.handlerNodeId] = (distribution[r.handlerNodeId] || 0) + 1;
  }

  console.log(`[ChurnTest:A1] Complete. ${allResults.length} successful, ${allFailures.length} failed, ${zombieCalls.length} zombie calls.`);

  return {
    totalCalls: allResults.length + allFailures.length,
    successfulCalls: allResults.length,
    failedCalls: allFailures.length,
    handlerNodeIds: [...liveNodeIds],
    distribution,
    failures: allFailures,
    latencyStats: computeLatencyStats(allMeasurements),
  };
}

// ────────────────────────────────────────────────────────────
// A2: Broadcast routing under listener churn
// ────────────────────────────────────────────────────────────

async function runBroadcastChurnTest(
  broker: any,
  waves: ChurnWave[],
  timeline: NodeIdTimelineEntry[],
): Promise<ChurnBroadcastResult> {
  console.log("[ChurnTest:A2] Broadcast routing under listener churn");

  const broadcastResults: ChurnBroadcastSingleResult[] = [];

  // Track restart times to determine which listeners are "recently restarted"
  const recentRestartTimestamps: Record<string, number> = {};
  const RESTART_GRACE_PERIOD_MS = 8000;

  // Discover current churn listener IDs from readiness files
  async function discoverLiveChurnListenerIds(): Promise<string[]> {
    const ids: string[] = [];
    // Try NATS monitoring first
    for (const prefix of CHURN_LISTENER_PREFIXES) {
      ids.push(...(await discoverNodeIdsByPrefix(prefix)));
    }
    // Also check readiness files as fallback
    const readyFiles = readReadinessFiles(CHURN_LISTENER_PREFIXES);
    for (const rf of readyFiles) {
      if (!ids.includes(rf.nodeId)) {
        ids.push(rf.nodeId);
      }
    }
    return ids;
  }

  // Helper to determine expected live listeners at broadcast time
  async function getExpectedAndOptionalListeners(): Promise<{
    expected: string[];
    optional: string[];
  }> {
    const now = Date.now();
    const expected: string[] = [...STATIC_LISTENER_IDS];
    const optional: string[] = [];

    const currentChurnIds = await discoverLiveChurnListenerIds();

    for (const prefix of CHURN_LISTENER_PREFIXES) {
      const isRecentlyRestarted = recentRestartTimestamps[prefix] &&
        (now - recentRestartTimestamps[prefix]) < RESTART_GRACE_PERIOD_MS;

      const matchingIds = currentChurnIds.filter((id) => id.startsWith(prefix));

      if (isRecentlyRestarted) {
        optional.push(...matchingIds);
      } else {
        expected.push(...matchingIds);
      }
    }

    return { expected, optional };
  }

  // Send initial broadcast (all listeners alive)
  const cid1 = uuidv4();
  console.log("[ChurnTest:A2] Sending broadcast #1 (all listeners alive)...");
  const { expected: exp1 } = await getExpectedAndOptionalListeners();
  await sendBroadcast(broker, cid1);
  broadcastResults.push({
    correlationId: cid1,
    sentAt: new Date().toISOString(),
    expectedLiveListeners: exp1,
    actualReceivers: [],
    missingReceivers: [],
    optionalReceivers: [],
    allExpectedReceived: false,
  });

  await sleep(2000);

  // Wave: restart churn-listener-1
  const oldCl1 = await discoverNodeIdsByPrefix("cl1");
  recentRestartTimestamps["cl1"] = Date.now();
  restartService("churn-listener-1");
  waves.push({
    waveNumber: waves.length + 1,
    serviceName: "churn-listener-1",
    action: "restart",
    timestamp: new Date().toISOString(),
    durationMs: 0,
    oldNodeIds: oldCl1,
    newNodeIds: [],
  });

  // Send broadcast during restart (listener-1 is in grace period)
  await sleep(1000);
  const cid2 = uuidv4();
  console.log("[ChurnTest:A2] Sending broadcast #2 (during listener-1 restart)...");
  const { expected: exp2, optional: opt2 } = await getExpectedAndOptionalListeners();
  await sendBroadcast(broker, cid2);
  broadcastResults.push({
    correlationId: cid2,
    sentAt: new Date().toISOString(),
    expectedLiveListeners: exp2,
    actualReceivers: [],
    missingReceivers: [],
    optionalReceivers: opt2,
    allExpectedReceived: false,
  });

  // Wave: restart churn-listener-2 and churn-listener-3 together
  await sleep(3000);
  const newCl1 = await discoverNodeIdsByPrefix("cl1");
  waves[waves.length - 1].newNodeIds = newCl1;

  const oldCl2 = await discoverNodeIdsByPrefix("cl2");
  const oldCl3 = await discoverNodeIdsByPrefix("cl3");
  recentRestartTimestamps["cl2"] = Date.now();
  recentRestartTimestamps["cl3"] = Date.now();
  restartService("churn-listener-2");
  restartService("churn-listener-3");
  waves.push({
    waveNumber: waves.length + 1,
    serviceName: "churn-listener-2,churn-listener-3",
    action: "restart",
    timestamp: new Date().toISOString(),
    durationMs: 0,
    oldNodeIds: [...oldCl2, ...oldCl3],
    newNodeIds: [],
  });

  // Send broadcast during multi-listener restart
  await sleep(1500);
  const cid3 = uuidv4();
  console.log("[ChurnTest:A2] Sending broadcast #3 (during listener-2,3 restart)...");
  const { expected: exp3, optional: opt3 } = await getExpectedAndOptionalListeners();
  await sendBroadcast(broker, cid3);
  broadcastResults.push({
    correlationId: cid3,
    sentAt: new Date().toISOString(),
    expectedLiveListeners: exp3,
    actualReceivers: [],
    missingReceivers: [],
    optionalReceivers: opt3,
    allExpectedReceived: false,
  });

  // Wait for all listeners to recover
  await sleep(6000);
  const newCl2 = await discoverNodeIdsByPrefix("cl2");
  const newCl3 = await discoverNodeIdsByPrefix("cl3");
  waves[waves.length - 1].newNodeIds = [...newCl2, ...newCl3];

  timeline.push({
    timestamp: new Date().toISOString(),
    event: "post-listener-churn-stabilized",
    activeNodeIds: [
      ...(await discoverNodeIdsFromNats(CHURN_LISTENER_PREFIXES)),
    ],
  });

  // Send final broadcast after stabilization — all churn listeners should be back
  delete recentRestartTimestamps["cl1"];
  delete recentRestartTimestamps["cl2"];
  delete recentRestartTimestamps["cl3"];
  delete recentRestartTimestamps["cl4"];

  const cid4 = uuidv4();
  console.log("[ChurnTest:A2] Sending broadcast #4 (post-stabilization)...");
  const { expected: exp4 } = await getExpectedAndOptionalListeners();
  await sendBroadcast(broker, cid4);
  broadcastResults.push({
    correlationId: cid4,
    sentAt: new Date().toISOString(),
    expectedLiveListeners: exp4,
    actualReceivers: [],
    missingReceivers: [],
    optionalReceivers: [],
    allExpectedReceived: false,
  });

  // Wait for evidence to settle
  await sleep(5000);

  // Read all broadcast receipt files
  const allReceipts = readBroadcastReceiptFiles();
  console.log(`[ChurnTest:A2] Collected ${allReceipts.length} total broadcast receipts from files.`);

  // Match receipts to each broadcast by correlationId
  let totalExpected = 0;
  let totalReceived = 0;

  for (const br of broadcastResults) {
    const matching = allReceipts.filter(
      (r: any) => r.correlationId === br.correlationId,
    );
    br.actualReceivers = [...new Set(matching.map((r: any) => r.receiverNodeId || r._nodeId))];

    // For expected static listeners, check actual receipt
    br.missingReceivers = br.expectedLiveListeners.filter(
      (expected) => !br.actualReceivers.includes(expected),
    );
    br.allExpectedReceived = br.missingReceivers.length === 0;

    totalExpected += br.expectedLiveListeners.length;
    totalReceived += br.actualReceivers.filter((a) =>
      br.expectedLiveListeners.includes(a),
    ).length;
  }

  const overallDeliveryRate = totalExpected > 0 ? totalReceived / totalExpected : 0;

  console.log(`[ChurnTest:A2] Complete. Delivery rate: ${(overallDeliveryRate * 100).toFixed(1)}%`);

  return {
    totalBroadcasts: broadcastResults.length,
    results: broadcastResults,
    overallDeliveryRate,
  };
}

// ────────────────────────────────────────────────────────────
// A3: Rapid restart cadence
// ────────────────────────────────────────────────────────────

async function runRapidRestartTest(
  broker: any,
  waves: ChurnWave[],
  timeline: NodeIdTimelineEntry[],
): Promise<ChurnCallResult> {
  console.log("[ChurnTest:A3] Rapid restart cadence");

  const allResults: CallEvidence[] = [];
  const allMeasurements: LatencyMeasurement[] = [];
  const allFailures: any[] = [];

  // Round 1: restart same node 4 times quickly
  console.log("[ChurnTest:A3] Round 1: Restarting churn-worker-1 x4 rapidly...");
  for (let i = 0; i < 4; i++) {
    const oldIds = await discoverNodeIdsByPrefix("cw1");
    restartService("churn-worker-1");
    waves.push({
      waveNumber: waves.length + 1,
      serviceName: "churn-worker-1",
      action: "restart",
      timestamp: new Date().toISOString(),
      durationMs: 0,
      oldNodeIds: oldIds,
      newNodeIds: [],
    });

    // Send calls between restarts
    const batch = await sendCalls(broker, 8, `rapid-restart-r1-${i}`, 40);
    allResults.push(...batch.results);
    allMeasurements.push(...batch.measurements);
    allFailures.push(...batch.failures);

    await sleep(1500);
  }

  // Discover new IDs after round 1
  await sleep(3000);
  const cw1After = await discoverNodeIdsByPrefix("cw1");
  timeline.push({
    timestamp: new Date().toISOString(),
    event: "after-rapid-restart-round-1",
    activeNodeIds: cw1After,
  });

  // Round 2: alternate restarts between two workers
  console.log("[ChurnTest:A3] Round 2: Alternating restarts between cw1 and cw2...");
  for (let i = 0; i < 3; i++) {
    const targets = i % 2 === 0 ? ["churn-worker-1"] : ["churn-worker-2"];
    const prefix = i % 2 === 0 ? "cw1" : "cw2";
    const oldIds = await discoverNodeIdsByPrefix(prefix);

    for (const t of targets) restartService(t);
    waves.push({
      waveNumber: waves.length + 1,
      serviceName: targets.join(","),
      action: "restart",
      timestamp: new Date().toISOString(),
      durationMs: 0,
      oldNodeIds: oldIds,
      newNodeIds: [],
    });

    const batch = await sendCalls(broker, 8, `rapid-restart-r2-${i}`, 40);
    allResults.push(...batch.results);
    allMeasurements.push(...batch.measurements);
    allFailures.push(...batch.failures);

    await sleep(1500);
  }

  // Round 3: restart all 3 churn workers nearly simultaneously
  console.log("[ChurnTest:A3] Round 3: Restarting all churn workers simultaneously...");
  const allOldIds: string[] = [];
  for (const prefix of CHURN_WORKER_PREFIXES) {
    allOldIds.push(...(await discoverNodeIdsByPrefix(prefix)));
  }
  for (const svc of CHURN_WORKER_SERVICES) {
    restartService(svc);
  }
  waves.push({
    waveNumber: waves.length + 1,
    serviceName: CHURN_WORKER_SERVICES.join(","),
    action: "restart",
    timestamp: new Date().toISOString(),
    durationMs: 0,
    oldNodeIds: allOldIds,
    newNodeIds: [],
  });

  // Send calls immediately
  const batch3 = await sendCalls(broker, 15, "rapid-restart-r3-simultaneous", 60);
  allResults.push(...batch3.results);
  allMeasurements.push(...batch3.measurements);
  allFailures.push(...batch3.failures);

  // Wait and discover
  await sleep(5000);
  const allNewIds: string[] = [];
  for (const prefix of CHURN_WORKER_PREFIXES) {
    allNewIds.push(...(await discoverNodeIdsByPrefix(prefix)));
  }
  waves[waves.length - 1].newNodeIds = allNewIds;

  timeline.push({
    timestamp: new Date().toISOString(),
    event: "after-rapid-restart-round-3",
    activeNodeIds: allNewIds,
  });

  // Final burst of calls after everything settles
  const postBatch = await sendCalls(broker, 15, "rapid-restart-post", 30);
  allResults.push(...postBatch.results);
  allMeasurements.push(...postBatch.measurements);
  allFailures.push(...postBatch.failures);

  const distribution: Record<string, number> = {};
  for (const r of allResults) {
    distribution[r.handlerNodeId] = (distribution[r.handlerNodeId] || 0) + 1;
  }

  console.log(`[ChurnTest:A3] Complete. ${allResults.length} successful, ${allFailures.length} failed.`);

  return {
    totalCalls: allResults.length + allFailures.length,
    successfulCalls: allResults.length,
    failedCalls: allFailures.length,
    handlerNodeIds: [...new Set(allResults.map((r) => r.handlerNodeId))],
    distribution,
    failures: allFailures,
    latencyStats: computeLatencyStats(allMeasurements),
  };
}

// ────────────────────────────────────────────────────────────
// A4: Stale-ID evidence collection
// ────────────────────────────────────────────────────────────

function collectStaleIdEvidence(
  timeline: NodeIdTimelineEntry[],
  waves: ChurnWave[],
): StaleIdEvidence {
  const allOldIds = new Set<string>();
  const allNewIds = new Set<string>();
  const transitions: StaleIdEvidence["transitionEvents"] = [];

  for (const wave of waves) {
    for (const oldId of wave.oldNodeIds) {
      allOldIds.add(oldId);
    }
    for (const newId of wave.newNodeIds) {
      allNewIds.add(newId);
    }

    if (wave.oldNodeIds.length > 0 && wave.newNodeIds.length > 0) {
      for (let i = 0; i < Math.max(wave.oldNodeIds.length, wave.newNodeIds.length); i++) {
        transitions.push({
          oldId: wave.oldNodeIds[i] || "(unknown)",
          newId: wave.newNodeIds[i] || "(not yet discovered)",
          service: wave.serviceName,
          timestamp: wave.timestamp,
        });
      }
    }
  }

  const trulyDead = [...allOldIds].filter((id) => !allNewIds.has(id));
  const currentLive = [...allNewIds];

  let conclusion: string;
  if (trulyDead.length > 0 && currentLive.length > 0) {
    conclusion =
      `${trulyDead.length} node ID(s) became obsolete after restarts, replaced by ${currentLive.length} new node ID(s). ` +
      `This confirms that restarted containers generated new identities. ` +
      `If calls/broadcasts continued working during these transitions, it demonstrates that ` +
      `NATS-level routing (not stale Moleculer registry entries) is driving delivery.`;
  } else if (trulyDead.length === 0) {
    conclusion =
      "No old node IDs were observed as definitively dead. This may indicate restarts were not " +
      "detected properly, or that discovery was too slow to capture the old IDs before they changed.";
  } else {
    conclusion =
      "Node ID transitions were observed, but new IDs were not fully captured. " +
      "Evidence is partial but still suggestive of dynamic identity changes.";
  }

  return {
    deadNodeIds: trulyDead,
    liveNodeIds: currentLive,
    transitionEvents: transitions,
    conclusion,
  };
}

// ────────────────────────────────────────────────────────────
// Main churn test suite entry point
// ────────────────────────────────────────────────────────────

export async function runChurnTestSuite(broker: any): Promise<ChurnTestSuiteResult> {
  console.log("");
  console.log("=".repeat(60));
  console.log("  CHURN / STALE-REGISTRY STRESS TEST (Suite A)");
  console.log("=".repeat(60));

  const waves: ChurnWave[] = [];
  const timeline: NodeIdTimelineEntry[] = [];
  const natsSnapshots: NatsSnapshot[] = [];

  // Clear previous churn evidence
  clearReadinessFiles(CHURN_WORKER_PREFIXES.concat(CHURN_LISTENER_PREFIXES));
  clearBroadcastReceiptFiles();

  // Start churn services
  startChurnServices();

  // Wait for churn services to be ready
  console.log("[ChurnTest] Waiting for churn services to connect...");
  const allPrefixes = [...CHURN_WORKER_PREFIXES, ...CHURN_LISTENER_PREFIXES];
  await waitForNatsConnections(7, allPrefixes, 45000);
  await sleep(3000);

  // Discover initial node IDs
  const initial = await discoverAllChurnNodeIds();
  console.log(`[ChurnTest] Initial churn workers: ${initial.workers.join(", ")}`);
  console.log(`[ChurnTest] Initial churn listeners: ${initial.listeners.join(", ")}`);

  timeline.push({
    timestamp: new Date().toISOString(),
    event: "churn-services-ready",
    activeNodeIds: [...initial.workers, ...initial.listeners],
  });

  // NATS snapshot before churn
  natsSnapshots.push(await takeNatsSnapshot("churn-pre", "churn"));

  // A1: Call routing under churn
  console.log("");
  const callResults = await runCallChurnTest(broker, waves, timeline);

  // A2: Broadcast routing under listener churn
  console.log("");
  const broadcastResults = await runBroadcastChurnTest(broker, waves, timeline);

  // NATS snapshot mid-churn
  natsSnapshots.push(await takeNatsSnapshot("churn-mid", "churn"));

  // A3: Rapid restart cadence
  console.log("");
  const rapidRestartResults = await runRapidRestartTest(broker, waves, timeline);

  // NATS snapshot after churn
  await sleep(3000);
  natsSnapshots.push(await takeNatsSnapshot("churn-post", "churn"));

  // A4: Stale-ID evidence
  const staleIdEvidence = collectStaleIdEvidence(timeline, waves);

  // Save churn evidence
  const fs = await import("fs");
  const path = await import("path");
  const outputDir = process.env.OUTPUT_DIR || "./output";
  const churnDir = path.join(outputDir, "churn");
  fs.mkdirSync(churnDir, { recursive: true });

  fs.writeFileSync(
    path.join(churnDir, "call-results.json"),
    JSON.stringify(callResults, null, 2),
  );
  fs.writeFileSync(
    path.join(churnDir, "broadcast-results.json"),
    JSON.stringify(broadcastResults, null, 2),
  );
  fs.writeFileSync(
    path.join(churnDir, "rapid-restart-results.json"),
    JSON.stringify(rapidRestartResults, null, 2),
  );
  fs.writeFileSync(
    path.join(churnDir, "stale-id-evidence.json"),
    JSON.stringify(staleIdEvidence, null, 2),
  );
  fs.writeFileSync(
    path.join(churnDir, "timeline.json"),
    JSON.stringify({ waves, timeline }, null, 2),
  );

  // Stop churn services
  console.log("[ChurnTest] Stopping churn services...");
  stopChurnServices();

  console.log("[ChurnTest] Churn test suite complete.");

  return {
    waves,
    nodeIdTimeline: timeline,
    callResults,
    broadcastResults,
    rapidRestartResults,
    natsSnapshots,
    staleIdEvidence,
  };
}
