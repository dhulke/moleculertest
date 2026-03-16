import { createBroker } from "../common/broker";
import { collectAndSaveNatsInfo, analyzeNatsSubscriptions } from "./collectNatsInfo";
import {
  assessCallDistribution,
  assessBroadcastFanout,
  evaluateH1,
  evaluateH2,
  evaluateH3,
  evaluateH4,
  evaluateH5,
  evaluateH6,
  evaluateH7,
  evaluateH8,
} from "./assertions";
import { saveReport } from "./report";
import {
  CallEvidence,
  BroadcastEvidence,
  ValidationReport,
  BroadcastTestResult,
  HypothesisResult,
  HypothesisExpectation,
  ChurnTestSuiteResult,
  ScaleTestSuiteResult,
} from "../common/types";
import { runChurnTestSuite } from "./churnTest";
import { runScaleTestSuite } from "./scaleTest";
import * as fs from "fs";
import * as path from "path";
import * as http from "http";

const OUTPUT_DIR = process.env.OUTPUT_DIR || "./output";
const NATS_MONITOR_URL = process.env.NATS_MONITOR_URL || "http://localhost:8222";
const SKIP_CHURN = process.env.SKIP_CHURN === "true";
const SKIP_SCALE = process.env.SKIP_SCALE === "true";
const DISABLE_BALANCER = process.env.DISABLE_BALANCER !== "false";
const CONTROL_MODE = !DISABLE_BALANCER;

const EXPECTED_LISTENER_NODES = [
  "listener-b-1",
  "listener-c-1",
  "listener-d-1",
  "listener-e-1",
  "broadcaster-1",
  "hybrid-1",
];

const ALL_NODE_IDS = [
  "caller-1",
  "broadcaster-1",
  "worker-a-1",
  "worker-a-2",
  "listener-b-1",
  "listener-c-1",
  "listener-d-1",
  "listener-e-1",
  "hybrid-1",
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function httpGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(data));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(5000, () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

async function waitForNats(maxRetries = 30): Promise<void> {
  console.log("[Validator] Waiting for NATS to be ready...");
  for (let i = 0; i < maxRetries; i++) {
    try {
      await httpGet(`${NATS_MONITOR_URL}/varz`);
      console.log("[Validator] NATS is ready.");
      return;
    } catch {
      console.log(`[Validator] NATS not ready yet (attempt ${i + 1}/${maxRetries})...`);
      await sleep(2000);
    }
  }
  throw new Error("NATS did not become ready in time");
}

async function waitForNodes(broker: any, expectedNodes: string[], maxWaitMs = 60000): Promise<string[]> {
  console.log(`[Validator] Waiting for nodes: ${expectedNodes.join(", ")}...`);
  const deadline = Date.now() + maxWaitMs;
  let foundNodes: string[] = [];

  while (Date.now() < deadline) {
    const nodeList = broker.registry.getNodeList({ onlyAvailable: true, withServices: true });
    foundNodes = nodeList.map((n: any) => n.id);

    const missing = expectedNodes.filter((n) => !foundNodes.includes(n));
    if (missing.length === 0) {
      console.log(`[Validator] All ${expectedNodes.length} nodes are available.`);
      return foundNodes;
    }

    console.log(`[Validator] Still waiting for: ${missing.join(", ")} (found ${foundNodes.length}/${expectedNodes.length})`);
    await sleep(3000);
  }

  const missing = expectedNodes.filter((n) => !foundNodes.includes(n));
  console.warn(`[Validator] WARNING: Timed out waiting for nodes. Missing: ${missing.join(", ")}`);
  console.warn(`[Validator] Proceeding with available nodes: ${foundNodes.join(", ")}`);
  return foundNodes;
}

async function runCallTest(broker: any): Promise<CallEvidence[]> {
  console.log("[Validator] Running call distribution test...");
  const result = await broker.call("caller.runCallTest", { count: 40 });
  console.log(`[Validator] Call test complete. ${result.results.length} successful calls.`);
  console.log(`[Validator] Distribution: ${JSON.stringify(result.distribution)}`);
  return result.results;
}

async function runBroadcastTest(broker: any): Promise<{ correlationIds: string[] }> {
  console.log("[Validator] Running broadcast test...");
  const result = await broker.call("broadcaster.sendMultipleBroadcasts", { count: 3 });
  console.log(`[Validator] Broadcast test complete. ${result.correlationIds.length} broadcasts sent.`);
  return result;
}

async function runHybridTest(broker: any): Promise<{
  distribution: Record<string, number>;
  localNodeId: string;
} | null> {
  console.log("[Validator] Running hybrid (local transport) test...");
  try {
    const result = await broker.call("hybridCaller.runLocalTest", { count: 20 });
    console.log(`[Validator] Hybrid test complete. Distribution: ${JSON.stringify(result.distribution)}`);
    return {
      distribution: result.distribution,
      localNodeId: result.localNodeId,
    };
  } catch (err: any) {
    console.warn(`[Validator] Hybrid test failed: ${err.message}`);
    return null;
  }
}

async function collectBroadcastEvidenceFromNodes(broker: any): Promise<BroadcastEvidence[]> {
  const allEvidence: BroadcastEvidence[] = [];

  for (const nodeId of EXPECTED_LISTENER_NODES) {
    try {
      const result = await broker.call(
        "listener.getReceivedBroadcasts",
        {},
        { nodeID: nodeId, timeout: 10000 },
      );
      if (result && result.broadcasts) {
        allEvidence.push(...result.broadcasts);
        console.log(`[Validator]   ${nodeId}: ${result.broadcasts.length} broadcast(s) received`);
      }
    } catch (err: any) {
      console.warn(`[Validator]   ${nodeId}: failed to collect evidence (${err.message})`);
    }
  }

  return allEvidence;
}

function buildInterpretation(analysis: any): string {
  const parts: string[] = [];

  if (analysis.queueGroups.length > 0) {
    parts.push(
      `Found ${analysis.queueGroups.length} queue group subscriptions. ` +
      `Queue groups indicate NATS-level load balancing.`,
    );
  }

  const reqbSubjects = analysis.actionSubjects.filter((s: string) => s.includes("REQB."));
  if (reqbSubjects.length > 0) {
    parts.push(
      `Found ${reqbSubjects.length} balanced request (REQB) subjects. ` +
      `NATS handles routing to one of the available service instances via queue groups.`,
    );
  }

  const eventSubs = analysis.eventSubjects;
  if (eventSubs.length > 0) {
    parts.push(
      `Found ${eventSubs.length} event subjects. ` +
      `Broadcast events use plain pub/sub (no queue group) so all subscribers receive the message.`,
    );
  }

  if (parts.length === 0) {
    parts.push("No Moleculer-specific NATS subjects were detected.");
  }

  return parts.join("\n\n");
}

function buildExpectedOutcomes(hasChurn: boolean, hasScale: boolean): HypothesisExpectation[] {
  if (!CONTROL_MODE) {
    // Normal mode: we expect everything to pass
    const expectations: HypothesisExpectation[] = [
      { id: "H1", expectedPass: true, reason: "NATS queue-group routing should distribute calls" },
      { id: "H2", expectedPass: true, reason: "Broadcast fanout works via NATS pub/sub" },
      { id: "H3", expectedPass: true, reason: "disableBalancer=true should use action-level subjects, not per-node routing" },
      { id: "H4", expectedPass: true, reason: "Local calls should go through transporter, not be short-circuited" },
    ];
    if (hasChurn) {
      expectations.push({ id: "H5", expectedPass: true, reason: "NATS-driven routing survives node churn" });
      expectations.push({ id: "H6", expectedPass: true, reason: "Broadcast fanout survives listener churn" });
    }
    if (hasScale) {
      expectations.push({ id: "H7", expectedPass: true, reason: "Delivery continues at scale" });
    }
    if (hasChurn) {
      expectations.push({ id: "H8", expectedPass: true, reason: "NATS subscribers drive delivery" });
    }
    return expectations;
  }

  // Control mode (disableBalancer=false): Moleculer's internal balancer is active.
  // Most hypotheses still PASS — calls succeed via retries, just with higher latency.
  // The only genuine behavioral difference is H4: with the balancer enabled,
  // Moleculer short-circuits local calls instead of sending them through NATS.
  const expectations: HypothesisExpectation[] = [
    { id: "H1", expectedPass: true, reason: "Calls still distribute across workers — Moleculer's internal balancer uses round-robin, which distributes similarly to NATS queue groups" },
    { id: "H2", expectedPass: true, reason: "Broadcast events always go over NATS pub/sub regardless of disableBalancer" },
    { id: "H3", expectedPass: true, reason: "Action-level NATS subjects still exist; the evidence is similar even though the routing mechanism differs internally" },
    { id: "H4", expectedPass: false, reason: "With balancer enabled, Moleculer prefers the local handler if available, so hybrid calls stay local instead of going through NATS" },
  ];
  if (hasChurn) {
    expectations.push({ id: "H5", expectedPass: true, reason: "Calls still succeed during churn thanks to the retry policy (3 retries, 500ms-3s delay), but with significantly higher latency due to 15s timeouts on stale registry entries" });
    expectations.push({ id: "H6", expectedPass: true, reason: "Broadcasts still fan out via NATS regardless of the balancer setting" });
  }
  if (hasScale) {
    expectations.push({ id: "H7", expectedPass: true, reason: "Calls succeed at scale via retries, but during-churn latency is orders of magnitude higher (seconds vs milliseconds) due to timeouts on stale registry entries" });
  }
  if (hasChurn) {
    expectations.push({ id: "H8", expectedPass: true, reason: "NATS monitoring still reflects current subscribers regardless of balancer setting; the evidence is similar" });
  }
  return expectations;
}

async function main() {
  const modeLabel = CONTROL_MODE
    ? "CONTROL EXPERIMENT (disableBalancer=false)"
    : "disableBalancer=true";

  console.log("=".repeat(60));
  console.log(`  Moleculer + NATS Validator — ${modeLabel}`);
  console.log("  (Extended: Baseline + Churn + Scale)");
  console.log("=".repeat(60));
  console.log("");

  if (CONTROL_MODE) {
    console.log("  *** CONTROL MODE ***");
    console.log("  Running with disableBalancer=false to compare behavior.");
    console.log("  Most tests still pass (via retries), but with higher latency.");
    console.log("  Only H4 (local call routing) should fail.");
    console.log("");
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.mkdirSync(path.join(OUTPUT_DIR, "churn"), { recursive: true });
  fs.mkdirSync(path.join(OUTPUT_DIR, "scale"), { recursive: true });

  await waitForNats();

  const broker = createBroker("validator-1");
  await broker.start();
  console.log(`[Validator] Validator broker started as ${broker.nodeID}`);

  const foundNodes = await waitForNodes(broker, ALL_NODE_IDS, 90000);

  // ════════════════════════════════════════════════════════════
  // PHASE 1: BASELINE VALIDATION
  // ════════════════════════════════════════════════════════════
  console.log("");
  console.log("=".repeat(60));
  console.log("  PHASE 1: BASELINE VALIDATION");
  console.log("=".repeat(60));

  console.log("");
  console.log("[Validator] ---- Baseline: Call Distribution Test ----");
  const callResults = await runCallTest(broker);

  console.log("");
  console.log("[Validator] ---- Baseline: Broadcast Fanout Test ----");
  const broadcastResult = await runBroadcastTest(broker);

  console.log("[Validator] Waiting for broadcasts to propagate...");
  await sleep(5000);

  console.log("[Validator] Collecting broadcast evidence from listener nodes...");
  const broadcastEvidence = await collectBroadcastEvidenceFromNodes(broker);
  console.log(`[Validator] Collected ${broadcastEvidence.length} total broadcast evidence records.`);

  fs.writeFileSync(
    path.join(OUTPUT_DIR, "broadcast-evidence-collected.json"),
    JSON.stringify(broadcastEvidence, null, 2),
  );

  console.log("");
  console.log("[Validator] ---- Baseline: Hybrid / Local Transport Test ----");
  const hybridResult = await runHybridTest(broker);

  console.log("[Validator] Waiting for all evidence to settle...");
  await sleep(3000);

  console.log("");
  console.log("[Validator] ---- Baseline: NATS Monitoring Collection ----");
  const natsInfo = await collectAndSaveNatsInfo("baseline");
  const natsAnalysis = analyzeNatsSubscriptions(natsInfo.connz, natsInfo.subsz);

  fs.writeFileSync(
    path.join(OUTPUT_DIR, "baseline", "nats-analysis.json"),
    JSON.stringify(natsAnalysis, null, 2),
  );

  console.log("");
  console.log("[Validator] ---- Baseline: Assessing Results ----");

  const callTestResult = assessCallDistribution(callResults);
  const broadcastTestResults: BroadcastTestResult[] = broadcastResult.correlationIds.map((cid) =>
    assessBroadcastFanout(cid, EXPECTED_LISTENER_NODES, broadcastEvidence),
  );

  const h1 = evaluateH1(callTestResult, natsAnalysis);
  const h2 = evaluateH2(broadcastTestResults);
  const h3 = evaluateH3(natsAnalysis);
  const h4 = evaluateH4(hybridResult, natsAnalysis);

  console.log(`[Validator] H1 (call routing): ${h1.passed ? "PASS" : "FAIL"}`);
  console.log(`[Validator] H2 (broadcast fanout): ${h2.passed ? "PASS" : "FAIL"}`);
  console.log(`[Validator] H3 (no per-node routing): ${h3.passed ? "PASS" : "FAIL"}`);
  console.log(`[Validator] H4 (local via transporter): ${h4.passed ? "PASS" : "FAIL"}`);

  // ════════════════════════════════════════════════════════════
  // PHASE 2: CHURN TEST
  // ════════════════════════════════════════════════════════════
  let churnTestResults: ChurnTestSuiteResult | undefined;
  let h5: HypothesisResult | undefined;
  let h6: HypothesisResult | undefined;

  if (!SKIP_CHURN) {
    console.log("");
    console.log("=".repeat(60));
    console.log("  PHASE 2: CHURN / STALE-REGISTRY STRESS TEST");
    console.log("=".repeat(60));

    try {
      churnTestResults = await runChurnTestSuite(broker);
      h5 = evaluateH5(churnTestResults);
      h6 = evaluateH6(churnTestResults);

      console.log(`[Validator] H5 (call during churn): ${h5.passed ? "PASS" : "FAIL"}`);
      console.log(`[Validator] H6 (broadcast during churn): ${h6.passed ? "PASS" : "FAIL"}`);
    } catch (err: any) {
      console.error(`[Validator] Churn test suite failed: ${err.message}`);
      console.error(err.stack);
    }

    await sleep(5000);
  } else {
    console.log("[Validator] Skipping churn test (SKIP_CHURN=true)");
  }

  // ════════════════════════════════════════════════════════════
  // PHASE 3: SCALE TEST
  // ════════════════════════════════════════════════════════════
  let scaleTestResults: ScaleTestSuiteResult | undefined;
  let h7: HypothesisResult | undefined;

  if (!SKIP_SCALE) {
    console.log("");
    console.log("=".repeat(60));
    console.log("  PHASE 3: SCALE / TRANSPORT-LOAD STRESS TEST");
    console.log("=".repeat(60));

    try {
      scaleTestResults = await runScaleTestSuite(broker);
      h7 = evaluateH7(scaleTestResults);

      console.log(`[Validator] H7 (scale churn resilience): ${h7.passed ? "PASS" : "FAIL"}`);
    } catch (err: any) {
      console.error(`[Validator] Scale test suite failed: ${err.message}`);
      console.error(err.stack);
    }

    await sleep(3000);
  } else {
    console.log("[Validator] Skipping scale test (SKIP_SCALE=true)");
  }

  // ════════════════════════════════════════════════════════════
  // PHASE 4: FINAL REPORT
  // ════════════════════════════════════════════════════════════
  console.log("");
  console.log("=".repeat(60));
  console.log("  PHASE 4: FINAL REPORT");
  console.log("=".repeat(60));

  // H8 evaluation (needs both churn and optionally scale data)
  let h8: HypothesisResult | undefined;
  if (churnTestResults) {
    h8 = evaluateH8(churnTestResults, scaleTestResults);
    console.log(`[Validator] H8 (NATS subscribers vs old IDs): ${h8.passed ? "PASS" : "FAIL"}`);
  }

  const allHypotheses: HypothesisResult[] = [h1, h2, h3, h4];
  if (h5) allHypotheses.push(h5);
  if (h6) allHypotheses.push(h6);
  if (h7) allHypotheses.push(h7);
  if (h8) allHypotheses.push(h8);

  const expectedOutcomes = buildExpectedOutcomes(!!churnTestResults, !!scaleTestResults);

  // In normal mode, overall pass means the key hypotheses passed.
  // In control mode, overall pass means actuals match the expected outcomes
  // (i.e., the expected failures did fail, and expected passes did pass).
  let overallPass: boolean;

  if (CONTROL_MODE) {
    let allExpectationsMet = true;
    for (const exp of expectedOutcomes) {
      const actual = allHypotheses.find((h) => h.id === exp.id);
      if (actual && actual.passed !== exp.expectedPass) {
        allExpectationsMet = false;
      }
    }
    overallPass = allExpectationsMet;
  } else {
    const corePass = h1.passed && h2.passed && h3.passed;
    const churnPass = h5 ? h5.passed : true;
    const broadcastChurnPass = h6 ? h6.passed : true;
    overallPass = corePass && churnPass && broadcastChurnPass;
  }

  const report: ValidationReport = {
    timestamp: new Date().toISOString(),
    environment: {
      containers: ALL_NODE_IDS,
      nodeIds: foundNodes,
      serviceRoles: {
        worker: "worker-a-1, worker-a-2, hybrid-1",
        caller: "caller-1",
        broadcaster: "broadcaster-1",
        listener: "listener-b-1, listener-c-1, listener-d-1, listener-e-1, broadcaster-1, hybrid-1",
        hybrid: "hybrid-1",
      },
    },
    moleculerConfig: {
      transporter: "NATS",
      disableBalancer: DISABLE_BALANCER,
      namespace: "demo",
    },
    controlMode: CONTROL_MODE,
    expectedOutcomes: CONTROL_MODE ? expectedOutcomes : undefined,
    callTestResults: callTestResult,
    broadcastTestResults,
    natsEvidence: {
      subsz: natsInfo.subsz,
      connz: { num_connections: natsInfo.connz.num_connections },
      relevantSubjects: natsAnalysis.relevantSubjects,
      queueGroups: natsAnalysis.queueGroups,
      nodeTargetedSubjects: natsAnalysis.nodeTargetedSubjects.slice(0, 30),
      interpretation: buildInterpretation(natsAnalysis),
    },
    hypotheses: allHypotheses,
    overallPass,
    churnTestResults,
    scaleTestResults,
  };

  saveReport(report);

  const modeTag = CONTROL_MODE ? " (CONTROL MODE)" : "";
  console.log("");
  console.log("=".repeat(60));
  if (CONTROL_MODE) {
    console.log(`  OVERALL RESULT: ${overallPass ? "EXPECTATIONS MET" : "UNEXPECTED RESULTS"}${modeTag}`);
    console.log("  Expected vs Actual:");
    for (const exp of expectedOutcomes) {
      const actual = allHypotheses.find((h) => h.id === exp.id);
      const actualLabel = actual ? (actual.passed ? "PASS" : "FAIL") : "N/A";
      const expectedLabel = exp.expectedPass ? "PASS" : "FAIL";
      const match = actual ? (actual.passed === exp.expectedPass ? "OK" : "MISMATCH") : "N/A";
      console.log(`    ${exp.id}: expected=${expectedLabel} actual=${actualLabel} → ${match}`);
    }
  } else {
    console.log(`  OVERALL RESULT: ${overallPass ? "PASS" : "SOME HYPOTHESES FAILED"}`);
    console.log("  Hypotheses:");
    for (const h of allHypotheses) {
      console.log(`    ${h.id}: ${h.passed ? "PASS" : "FAIL"} (${h.confidence})`);
    }
  }
  console.log("=".repeat(60));

  await broker.stop();
  process.exit(overallPass ? 0 : 1);
}

main().catch((err) => {
  console.error("[Validator] Fatal error:", err);
  process.exit(2);
});
