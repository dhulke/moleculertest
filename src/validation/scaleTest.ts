import { v4 as uuidv4 } from "uuid";
import {
  ScaleTestSuiteResult,
  LatencyMeasurement,
  LatencyStats,
  NatsSnapshot,
  CallEvidence,
  CallTestPayload,
  BroadcastTestPayload,
} from "../common/types";
import { computeLatencyStats } from "./churnTest";
import {
  startScaleServices,
  stopScaleServices,
  getScaleContainerIds,
  killContainers,
  discoverNodeIdsFromNats,
  waitForNatsConnections,
  readBroadcastReceiptFiles,
  clearBroadcastReceiptFiles,
  takeNatsSnapshot,
  sleep,
} from "./dockerOrchestrator";

const SCALE_WORKERS = parseInt(process.env.SCALE_WORKERS || "10", 10);
const SCALE_LISTENERS = parseInt(process.env.SCALE_LISTENERS || "10", 10);

async function measureCallLatency(
  broker: any,
  count: number,
  phase: string,
  delayMs = 30,
): Promise<LatencyMeasurement[]> {
  const measurements: LatencyMeasurement[] = [];

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
      measurements.push({
        phase,
        latencyMs: Date.now() - start,
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
    }
    if (delayMs > 0) await sleep(delayMs);
  }

  return measurements;
}

async function measureBroadcastDelivery(
  broker: any,
  count: number,
  phase: string,
): Promise<{
  broadcasts: Array<{ correlationId: string; sentAt: string }>;
  phase: string;
}> {
  const broadcasts: Array<{ correlationId: string; sentAt: string }> = [];

  for (let i = 0; i < count; i++) {
    const correlationId = uuidv4();
    const sentAt = new Date().toISOString();
    const payload: BroadcastTestPayload = {
      correlationId,
      sentBy: broker.nodeID,
      sentAt,
      message: `scale-broadcast-${phase}-${i}`,
    };
    broker.broadcast("demo.broadcast", payload);
    broadcasts.push({ correlationId, sentAt });
    await sleep(200);
  }

  return { broadcasts, phase };
}

export async function runScaleTestSuite(broker: any): Promise<ScaleTestSuiteResult> {
  console.log("");
  console.log("=".repeat(60));
  console.log("  SCALE / TRANSPORT-LOAD STRESS TEST (Suite B)");
  console.log("=".repeat(60));

  const natsSnapshots: NatsSnapshot[] = [];
  const workerCount = SCALE_WORKERS;
  const listenerCount = SCALE_LISTENERS;

  console.log(`[ScaleTest] Configuration: ${workerCount} workers, ${listenerCount} listeners`);

  // Clear previous scale evidence
  clearBroadcastReceiptFiles(["sw", "sl"]);

  // ── B1: Start many nodes ──
  console.log("[ScaleTest:B1] Starting scale fleet...");
  startScaleServices(workerCount, listenerCount);

  // Wait for connections
  console.log("[ScaleTest:B1] Waiting for scale services to connect...");
  const targetConnections = workerCount + listenerCount;
  await waitForNatsConnections(
    Math.floor(targetConnections * 0.8),
    ["sw", "sl"],
    60000,
  );
  await sleep(5000);

  const initialWorkerIds = await discoverNodeIdsFromNats(["sw"]);
  const initialListenerIds = await discoverNodeIdsFromNats(["sl"]);
  console.log(`[ScaleTest:B1] Scale fleet ready: ${initialWorkerIds.length} workers, ${initialListenerIds.length} listeners`);

  // NATS snapshot at scale
  natsSnapshots.push(await takeNatsSnapshot("scale-initial", "scale"));

  // ── B3 (before churn): Latency measurement ──
  console.log("[ScaleTest:B3] Measuring latency BEFORE churn...");
  const latencyBefore = await measureCallLatency(broker, 30, "before-churn", 20);
  const statsBefore = computeLatencyStats(latencyBefore);
  console.log(`[ScaleTest:B3] Before-churn latency: avg=${statsBefore.avgMs}ms, p95=${statsBefore.p95Ms}ms, success=${(statsBefore.successRate * 100).toFixed(0)}%`);

  // Broadcast measurement before churn
  const bcBefore = await measureBroadcastDelivery(broker, 2, "before-churn");
  await sleep(3000);

  // ── B2: Scale churn ──
  console.log("[ScaleTest:B2] Starting scale churn...");

  // Phase 1: kill ~40% of workers
  const killCount1 = Math.max(2, Math.floor(workerCount * 0.4));
  console.log(`[ScaleTest:B2] Phase 1: Killing ${killCount1} workers...`);
  const workerContainers1 = getScaleContainerIds("scale-worker");
  const toKill1 = workerContainers1
    .sort(() => Math.random() - 0.5)
    .slice(0, killCount1);
  killContainers(toKill1);

  await sleep(2000);
  natsSnapshots.push(await takeNatsSnapshot("scale-after-kill-1", "scale"));

  // Measure latency during churn
  console.log("[ScaleTest:B3] Measuring latency DURING churn (after kill phase 1)...");
  const latencyDuring1 = await measureCallLatency(broker, 20, "during-churn-1", 30);

  // Phase 2: restart scale workers (docker compose up ensures desired count)
  console.log(`[ScaleTest:B2] Phase 2: Restoring scale workers to ${workerCount}...`);
  startScaleServices(workerCount, listenerCount);
  await sleep(5000);

  // Phase 3: kill ~40% of listeners
  const killCount2 = Math.max(2, Math.floor(listenerCount * 0.4));
  console.log(`[ScaleTest:B2] Phase 3: Killing ${killCount2} listeners...`);
  const listenerContainers = getScaleContainerIds("scale-listener");
  const toKill2 = listenerContainers
    .sort(() => Math.random() - 0.5)
    .slice(0, killCount2);
  killContainers(toKill2);

  await sleep(2000);

  // Broadcast during listener churn
  const bcDuring = await measureBroadcastDelivery(broker, 2, "during-churn");

  // Phase 4: restore and kill a different subset
  console.log(`[ScaleTest:B2] Phase 4: Restoring and killing different workers...`);
  startScaleServices(workerCount, listenerCount);
  await sleep(5000);

  const workerContainers2 = getScaleContainerIds("scale-worker");
  const killCount3 = Math.max(2, Math.floor(workerCount * 0.3));
  const toKill3 = workerContainers2
    .sort(() => Math.random() - 0.5)
    .slice(0, killCount3);
  killContainers(toKill3);

  await sleep(2000);

  // Measure latency during churn phase 2
  const latencyDuring2 = await measureCallLatency(broker, 20, "during-churn-2", 30);

  natsSnapshots.push(await takeNatsSnapshot("scale-mid-churn", "scale"));

  // Phase 5: full restore
  console.log("[ScaleTest:B2] Phase 5: Full restore...");
  startScaleServices(workerCount, listenerCount);
  await sleep(8000);

  // ── B3 (after churn): Latency measurement ──
  console.log("[ScaleTest:B3] Measuring latency AFTER churn...");
  const latencyAfter = await measureCallLatency(broker, 30, "after-churn", 20);
  const statsAfter = computeLatencyStats(latencyAfter);
  console.log(`[ScaleTest:B3] After-churn latency: avg=${statsAfter.avgMs}ms, p95=${statsAfter.p95Ms}ms, success=${(statsAfter.successRate * 100).toFixed(0)}%`);

  // Broadcast measurement after churn
  const bcAfter = await measureBroadcastDelivery(broker, 2, "after-churn");
  await sleep(5000);

  // ── B4: Transport load evidence ──
  natsSnapshots.push(await takeNatsSnapshot("scale-final", "scale"));

  const postWorkerIds = await discoverNodeIdsFromNats(["sw"]);
  const postListenerIds = await discoverNodeIdsFromNats(["sl"]);
  console.log(`[ScaleTest:B4] Final fleet: ${postWorkerIds.length} workers, ${postListenerIds.length} listeners`);

  // Compute combined during-churn stats
  const allDuringMeasurements = [...latencyDuring1, ...latencyDuring2];
  const statsDuring = computeLatencyStats(allDuringMeasurements);

  // Compute broadcast delivery rate
  const allBcCorrelationIds = [
    ...bcBefore.broadcasts, ...bcDuring.broadcasts, ...bcAfter.broadcasts,
  ].map((b) => b.correlationId);

  const allBcReceipts = readBroadcastReceiptFiles();
  let totalBcReceipts = 0;
  for (const cid of allBcCorrelationIds) {
    const matching = allBcReceipts.filter((r: any) => r.correlationId === cid);
    totalBcReceipts += matching.length;
  }
  const expectedBcReceipts = allBcCorrelationIds.length * Math.max(1, postListenerIds.length);
  const bcDeliveryRate = expectedBcReceipts > 0
    ? Math.min(1, totalBcReceipts / expectedBcReceipts)
    : 0;

  // Compute call success rate
  const allCallMeasurements = [...latencyBefore, ...allDuringMeasurements, ...latencyAfter];
  const callSuccessRate = allCallMeasurements.length > 0
    ? allCallMeasurements.filter((m) => m.success).length / allCallMeasurements.length
    : 0;

  // Save evidence
  const fs = await import("fs");
  const pathMod = await import("path");
  const outputDir = process.env.OUTPUT_DIR || "./output";
  const scaleDir = pathMod.join(outputDir, "scale");
  fs.mkdirSync(scaleDir, { recursive: true });

  fs.writeFileSync(
    pathMod.join(scaleDir, "latency-before.json"),
    JSON.stringify({ phase: "before-churn", stats: statsBefore, raw: latencyBefore }, null, 2),
  );
  fs.writeFileSync(
    pathMod.join(scaleDir, "latency-during.json"),
    JSON.stringify({ phase: "during-churn", stats: statsDuring, raw: allDuringMeasurements }, null, 2),
  );
  fs.writeFileSync(
    pathMod.join(scaleDir, "latency-after.json"),
    JSON.stringify({ phase: "after-churn", stats: statsAfter, raw: latencyAfter }, null, 2),
  );
  fs.writeFileSync(
    pathMod.join(scaleDir, "broadcast-delivery.json"),
    JSON.stringify({
      totalBroadcasts: allBcCorrelationIds.length,
      totalReceipts: totalBcReceipts,
      deliveryRate: bcDeliveryRate,
      correlationIds: allBcCorrelationIds,
    }, null, 2),
  );

  const churnPattern = [
    `Kill ${killCount1}/${workerCount} workers`,
    "Restore workers",
    `Kill ${killCount2}/${listenerCount} listeners`,
    "Restore all",
    `Kill ${killCount3}/${workerCount} different workers`,
    "Full restore",
  ].join(" → ");

  // Stop scale services
  console.log("[ScaleTest] Stopping scale services...");
  stopScaleServices();

  console.log("[ScaleTest] Scale test suite complete.");

  return {
    workerCount,
    listenerCount,
    latencyBefore: statsBefore,
    latencyDuring: statsDuring,
    latencyAfter: statsAfter,
    callSuccessRate,
    broadcastDeliveryRate: bcDeliveryRate,
    churnPattern,
    natsSnapshots,
  };
}
