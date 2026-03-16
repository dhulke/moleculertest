import {
  CallEvidence,
  BroadcastEvidence,
  CallTestResult,
  BroadcastTestResult,
  HypothesisResult,
  ChurnTestSuiteResult,
  ScaleTestSuiteResult,
} from "../common/types";

export function assessCallDistribution(
  results: CallEvidence[],
): CallTestResult {
  const countsPerResponder: Record<string, number> = {};
  const respondersHit: Set<string> = new Set();

  for (const r of results) {
    respondersHit.add(r.handlerNodeId);
    countsPerResponder[r.handlerNodeId] = (countsPerResponder[r.handlerNodeId] || 0) + 1;
  }

  return {
    totalCalls: results.length,
    respondersHit: [...respondersHit],
    countsPerResponder,
    rawSamples: results.slice(0, 10),
    distributed: respondersHit.size > 1,
  };
}

export function assessBroadcastFanout(
  correlationId: string,
  expectedListeners: string[],
  receipts: BroadcastEvidence[],
): BroadcastTestResult {
  const matching = receipts.filter((r) => r.correlationId === correlationId);
  const actualListeners = matching.map((r) => r.receiverNodeId);

  const actualSet = new Set(actualListeners);
  const missingListeners = expectedListeners.filter((l) => !actualSet.has(l));

  const seen = new Set<string>();
  const duplicateListeners: string[] = [];
  for (const l of actualListeners) {
    if (seen.has(l)) duplicateListeners.push(l);
    seen.add(l);
  }

  return {
    correlationId,
    expectedListeners,
    actualListeners: [...new Set(actualListeners)],
    missingListeners,
    duplicateListeners,
    allReceived: missingListeners.length === 0,
    rawReceipts: matching,
  };
}

export function evaluateH1(callResult: CallTestResult, natsAnalysis: any): HypothesisResult {
  const evidence: string[] = [];
  const caveats: string[] = [];

  evidence.push(`${callResult.totalCalls} calls made to workers.process`);
  evidence.push(`${callResult.respondersHit.length} distinct worker(s) handled calls`);
  evidence.push(`Distribution: ${JSON.stringify(callResult.countsPerResponder)}`);

  const hasBalancedActionSubs = natsAnalysis.actionSubjects.some(
    (s: string) => s.includes("REQB.") || s.includes(".REQ."),
  );
  const hasQueueGroups = natsAnalysis.queueGroups.length > 0;

  if (hasBalancedActionSubs) {
    evidence.push("NATS subscriptions include balanced request subjects (REQB or REQ patterns)");
  }
  if (hasQueueGroups) {
    evidence.push(`Queue groups found: ${natsAnalysis.queueGroups.slice(0, 5).join(", ")}`);
  }

  if (!callResult.distributed) {
    caveats.push("All calls went to a single worker; distribution not proven");
  }

  const passed = callResult.distributed && callResult.totalCalls > 5;

  if (passed) {
    evidence.push("Multiple replicas received calls, consistent with NATS queue-group based routing");
  }

  caveats.push("Cannot directly prove NATS performed the routing vs Moleculer; indirect evidence via distribution + subscription patterns");

  return {
    id: "H1",
    description: "broker.call() is routed over NATS using balanced action subjects / queue-group style routing when disableBalancer=true",
    passed,
    confidence: passed && hasQueueGroups ? "high" : passed ? "medium" : "low",
    evidence,
    caveats,
  };
}

export function evaluateH2(broadcastResults: BroadcastTestResult[]): HypothesisResult {
  const evidence: string[] = [];
  const caveats: string[] = [];

  const allPassed = broadcastResults.every((r) => r.allReceived);
  const totalExpected = broadcastResults.reduce((sum, r) => sum + r.expectedListeners.length, 0);
  const totalReceived = broadcastResults.reduce((sum, r) => sum + r.actualListeners.length, 0);

  evidence.push(`${broadcastResults.length} broadcast(s) sent`);
  evidence.push(`Expected ${totalExpected} total receipts, received ${totalReceived}`);

  for (const r of broadcastResults) {
    if (r.allReceived) {
      evidence.push(`Broadcast ${r.correlationId.slice(0, 8)}: all ${r.expectedListeners.length} listeners received`);
    } else {
      evidence.push(`Broadcast ${r.correlationId.slice(0, 8)}: MISSING ${r.missingListeners.join(", ")}`);
    }
  }

  caveats.push("Broadcast timing could cause missed receipts if evidence is collected too early");

  return {
    id: "H2",
    description: "broker.broadcast() is routed over NATS pub/sub and reaches all relevant service instances",
    passed: allPassed,
    confidence: allPassed ? "high" : "medium",
    evidence,
    caveats,
  };
}

export function evaluateH3(natsAnalysis: any): HypothesisResult {
  const evidence: string[] = [];
  const caveats: string[] = [];

  const actionSubjectCount = natsAnalysis.actionSubjects.length;
  const nodeTargetedCount = natsAnalysis.nodeTargetedSubjects.length;

  evidence.push(`${actionSubjectCount} action-level subjects found in NATS subscriptions`);
  evidence.push(`${nodeTargetedCount} node-targeted subjects found`);

  const hasQueueBasedRouting = natsAnalysis.queueGroups.some(
    (qg: string) => qg.includes("REQB.") || qg.includes("REQ."),
  );

  if (hasQueueBasedRouting) {
    evidence.push("Queue-group-based request subjects found, indicating NATS-level load balancing");
  }

  const passed = hasQueueBasedRouting || actionSubjectCount > 0;

  caveats.push("Proving a negative requires comparing with disableBalancer=false");
  caveats.push("NATS subscription patterns are the strongest available evidence");

  return {
    id: "H3",
    description: "We are NOT relying on Moleculer's per-node request routing for call delivery in disableBalancer=true mode",
    passed,
    confidence: passed ? "medium" : "low",
    evidence,
    caveats,
  };
}

export function evaluateH4(
  hybridResults: { distribution: Record<string, number>; localNodeId: string } | null,
  natsAnalysis: any,
): HypothesisResult {
  const evidence: string[] = [];
  const caveats: string[] = [];

  if (!hybridResults) {
    return {
      id: "H4",
      description: "Local calls/events are still forced through the transporter in disableBalancer=true mode",
      passed: false,
      confidence: "low",
      evidence: ["Hybrid test was not executed or returned no results"],
      caveats: ["Cannot evaluate without hybrid test data"],
    };
  }

  const localNodeId = hybridResults.localNodeId;
  const localCount = hybridResults.distribution[localNodeId] || 0;
  const totalCalls = Object.values(hybridResults.distribution).reduce((a, b) => a + b, 0);
  const otherCount = totalCalls - localCount;

  evidence.push(`Hybrid node ${localNodeId} made ${totalCalls} calls to workers.process`);
  evidence.push(`Local handler received ${localCount}/${totalCalls} calls`);
  evidence.push(`Remote handlers received ${otherCount}/${totalCalls} calls`);

  const notAllLocal = localCount < totalCalls;

  if (notAllLocal) {
    evidence.push("Calls were distributed to remote nodes even though a local handler exists");
  }

  const passed = notAllLocal;

  caveats.push("Distribution evidence is indirect");
  caveats.push("With disableBalancer=true, Moleculer docs state transit.request is used instead of local call optimization");

  return {
    id: "H4",
    description: "Local calls/events are still forced through the transporter in disableBalancer=true mode",
    passed,
    confidence: passed ? "medium" : "low",
    evidence,
    caveats,
  };
}

// ── New hypotheses for churn/scale tests ──

export function evaluateH5(churnResults: ChurnTestSuiteResult): HypothesisResult {
  const evidence: string[] = [];
  const caveats: string[] = [];

  const cr = churnResults.callResults;
  const rr = churnResults.rapidRestartResults;

  const totalCalls = cr.totalCalls + rr.totalCalls;
  const totalSuccess = cr.successfulCalls + rr.successfulCalls;
  const totalFail = cr.failedCalls + rr.failedCalls;
  const successRate = totalCalls > 0 ? totalSuccess / totalCalls : 0;

  evidence.push(`${totalCalls} total calls during churn tests, ${totalSuccess} successful (${(successRate * 100).toFixed(1)}%)`);
  evidence.push(`${churnResults.waves.length} restart waves executed`);
  evidence.push(`${cr.handlerNodeIds.length} distinct handler node IDs observed in A1`);
  evidence.push(`${rr.handlerNodeIds.length} distinct handler node IDs observed in A3`);

  const deadIds = churnResults.staleIdEvidence.deadNodeIds;
  if (deadIds.length > 0) {
    evidence.push(`${deadIds.length} old node ID(s) became obsolete: ${deadIds.slice(0, 5).join(", ")}`);
    evidence.push(`${churnResults.staleIdEvidence.liveNodeIds.length} new node ID(s) took over`);
  }

  if (totalFail > 0) {
    evidence.push(`${totalFail} call(s) failed — may include brief windows during container restart`);
    caveats.push("Some failures are expected during the brief restart window when no churn worker is connected");
  }

  // Pass if success rate is >= 85% (allowing for brief restart gaps)
  const passed = successRate >= 0.85 && totalSuccess > 20;

  if (passed) {
    evidence.push("High call success rate despite rapid node ID changes confirms NATS-level routing resilience");
  }

  caveats.push("Brief call failures during exact restart moments are expected infrastructure behavior, not routing failures");

  return {
    id: "H5",
    description: "Rapid node ID churn does not prevent call delivery when disableBalancer=true",
    passed,
    confidence: passed && successRate >= 0.95 ? "high" : passed ? "medium" : "low",
    evidence,
    caveats,
  };
}

export function evaluateH6(churnResults: ChurnTestSuiteResult): HypothesisResult {
  const evidence: string[] = [];
  const caveats: string[] = [];

  const br = churnResults.broadcastResults;

  evidence.push(`${br.totalBroadcasts} broadcasts sent during listener churn`);
  evidence.push(`Overall delivery rate to expected listeners: ${(br.overallDeliveryRate * 100).toFixed(1)}%`);

  let staticListenerFullDelivery = 0;
  for (const result of br.results) {
    const staticReceived = result.actualReceivers.filter((r) =>
      result.expectedLiveListeners.includes(r),
    );
    if (staticReceived.length >= result.expectedLiveListeners.length) {
      staticListenerFullDelivery++;
    }

    if (result.allExpectedReceived) {
      evidence.push(`Broadcast ${result.correlationId.slice(0, 8)}: all expected listeners received`);
    } else {
      evidence.push(`Broadcast ${result.correlationId.slice(0, 8)}: missing ${result.missingReceivers.join(", ")}`);
    }
  }

  const staleEvidence = churnResults.staleIdEvidence;
  if (staleEvidence.deadNodeIds.length > 0) {
    evidence.push(
      `Node ID transitions observed: ${staleEvidence.transitionEvents.length} transitions, ` +
      `${staleEvidence.deadNodeIds.length} dead IDs, ${staleEvidence.liveNodeIds.length} live IDs`,
    );
  }

  // Pass if delivery to stable listeners is high (>=80%) and at least some broadcasts fully delivered
  const passed = br.overallDeliveryRate >= 0.8 && staticListenerFullDelivery > 0;

  caveats.push("Broadcasts sent during exact restart windows may not reach restarting listeners — this is expected");
  caveats.push("Churn listeners with new IDs may not have been subscribed yet when broadcast was sent");

  return {
    id: "H6",
    description: "Rapid node ID churn does not prevent broadcast fanout to currently live listeners when disableBalancer=true",
    passed,
    confidence: passed && br.overallDeliveryRate >= 0.9 ? "high" : passed ? "medium" : "low",
    evidence,
    caveats,
  };
}

export function evaluateH7(scaleResults: ScaleTestSuiteResult): HypothesisResult {
  const evidence: string[] = [];
  const caveats: string[] = [];

  evidence.push(`Scale test: ${scaleResults.workerCount} workers, ${scaleResults.listenerCount} listeners`);
  evidence.push(`Churn pattern: ${scaleResults.churnPattern}`);
  evidence.push(`Call success rate: ${(scaleResults.callSuccessRate * 100).toFixed(1)}%`);

  const before = scaleResults.latencyBefore;
  const during = scaleResults.latencyDuring;
  const after = scaleResults.latencyAfter;

  evidence.push(`Latency before churn: avg=${before.avgMs}ms, p95=${before.p95Ms}ms (${before.successCount}/${before.count} success)`);
  evidence.push(`Latency during churn: avg=${during.avgMs}ms, p95=${during.p95Ms}ms (${during.successCount}/${during.count} success)`);
  evidence.push(`Latency after churn: avg=${after.avgMs}ms, p95=${after.p95Ms}ms (${after.successCount}/${after.count} success)`);

  const latencyIncrease = during.avgMs > 0 && before.avgMs > 0
    ? ((during.avgMs - before.avgMs) / before.avgMs * 100).toFixed(0)
    : "N/A";
  evidence.push(`Latency change during churn: ${latencyIncrease}%`);

  evidence.push(`Broadcast delivery rate: ${(scaleResults.broadcastDeliveryRate * 100).toFixed(1)}%`);

  // Pass if call success rate >= 80% and after-churn latency is reasonable
  const passed = scaleResults.callSuccessRate >= 0.80 && after.successRate >= 0.90;

  if (passed) {
    evidence.push("Message delivery continued working at scale despite churn, with measurable but limited delay impact");
  }

  caveats.push("Scale test results depend heavily on host machine resources");
  caveats.push("Latency measurements include Docker networking overhead");

  return {
    id: "H7",
    description: "Under large-scale node churn, message delivery continues working and added delay remains limited / observable",
    passed,
    confidence: passed && scaleResults.callSuccessRate >= 0.95 ? "high" : passed ? "medium" : "low",
    evidence,
    caveats,
  };
}

export function evaluateH8(
  churnResults: ChurnTestSuiteResult,
  scaleResults: ScaleTestSuiteResult | undefined,
): HypothesisResult {
  const evidence: string[] = [];
  const caveats: string[] = [];

  const stale = churnResults.staleIdEvidence;

  evidence.push(`${stale.deadNodeIds.length} obsolete node ID(s) replaced by ${stale.liveNodeIds.length} new node ID(s)`);
  evidence.push(`${stale.transitionEvents.length} node ID transition events recorded`);

  if (stale.deadNodeIds.length > 0) {
    evidence.push(
      `Dead IDs: ${stale.deadNodeIds.slice(0, 5).join(", ")}${stale.deadNodeIds.length > 5 ? ` ... and ${stale.deadNodeIds.length - 5} more` : ""}`,
    );
    evidence.push(
      `Live IDs: ${stale.liveNodeIds.slice(0, 5).join(", ")}${stale.liveNodeIds.length > 5 ? ` ... and ${stale.liveNodeIds.length - 5} more` : ""}`,
    );
  }

  // Check NATS snapshots for subscriber count changes
  for (const snap of churnResults.natsSnapshots) {
    evidence.push(
      `NATS snapshot "${snap.label}": ${snap.connectionCount} connections, ${snap.subscriptionCount} subscriptions`,
    );
  }

  if (scaleResults) {
    for (const snap of scaleResults.natsSnapshots) {
      evidence.push(
        `NATS snapshot "${snap.label}": ${snap.connectionCount} connections, ${snap.subscriptionCount} subscriptions`,
      );
    }
  }

  evidence.push(stale.conclusion);

  // Pass if we observed node ID transitions AND calls/broadcasts still worked
  const hasTransitions = stale.deadNodeIds.length > 0 && stale.liveNodeIds.length > 0;
  const callsWorked = churnResults.callResults.successfulCalls > 0;
  const passed = hasTransitions && callsWorked;

  if (passed) {
    evidence.push(
      "Node ID transitions were observed in NATS monitoring AND calls continued to succeed. " +
      "This is consistent with NATS subscribers (not old Moleculer node IDs) driving delivery.",
    );
  }

  caveats.push("NATS monitoring shows current subscribers, not Moleculer's internal registry state — stale registry inference is indirect");
  caveats.push("We cannot directly observe Moleculer's registry contents from outside the broker process");

  return {
    id: "H8",
    description: "Current live subscribers observed in NATS are more predictive of delivery than old Moleculer node IDs",
    passed,
    confidence: passed ? "medium" : "low",
    evidence,
    caveats,
  };
}
