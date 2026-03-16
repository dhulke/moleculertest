import * as fs from "fs";
import * as path from "path";
import { ValidationReport, HypothesisResult, HypothesisExpectation, ChurnTestSuiteResult, ScaleTestSuiteResult, LatencyStats } from "../common/types";

const OUTPUT_DIR = process.env.OUTPUT_DIR || "./output";

function formatLatencyStats(stats: LatencyStats): string {
  return [
    `  - Count: ${stats.count} (${stats.successCount} success, ${stats.failureCount} failed)`,
    `  - Success rate: ${(stats.successRate * 100).toFixed(1)}%`,
    `  - Min: ${stats.minMs}ms, Max: ${stats.maxMs}ms, Avg: ${stats.avgMs}ms`,
    `  - p50: ${stats.p50Ms}ms, p95: ${stats.p95Ms}ms`,
  ].join("\n");
}

export function generateMarkdownReport(report: ValidationReport): string {
  const lines: string[] = [];

  const modeLabel = report.controlMode
    ? "CONTROL EXPERIMENT (disableBalancer=false)"
    : "disableBalancer=true";

  lines.push(`# Moleculer + NATS Validation Report — ${modeLabel}`);
  lines.push("");
  lines.push(`**Generated:** ${report.timestamp}`);
  lines.push(`**Mode:** ${modeLabel}`);
  lines.push("");

  if (report.controlMode) {
    lines.push("> **CONTROL EXPERIMENT**: This run uses `disableBalancer=false` to verify behavioral");
    lines.push("> differences when Moleculer's internal balancer is active. With the balancer enabled,");
    lines.push("> calls are routed using Moleculer's per-node registry instead of NATS queue groups.");
    lines.push("> Most tests still pass (retries cover stale-registry timeouts), but with significantly");
    lines.push("> higher latency during churn. The key difference is **H4**: local calls are");
    lines.push("> short-circuited instead of going through NATS.");
    lines.push("");
  }

  // ── 1. Environment ──
  lines.push("## 1. Environment Summary");
  lines.push("");
  lines.push("| Property | Value |");
  lines.push("|----------|-------|");
  lines.push(`| Containers | ${report.environment.containers.join(", ")} |`);
  lines.push(`| Node IDs | ${report.environment.nodeIds.join(", ")} |`);
  for (const [role, nodes] of Object.entries(report.environment.serviceRoles)) {
    lines.push(`| Role: ${role} | ${nodes} |`);
  }
  lines.push("");

  // ── 2. Moleculer Config ──
  lines.push("## 2. Moleculer Config");
  lines.push("");
  lines.push("| Setting | Value |");
  lines.push("|---------|-------|");
  lines.push(`| Transporter | ${report.moleculerConfig.transporter} |`);
  lines.push(`| disableBalancer | ${report.moleculerConfig.disableBalancer} |`);
  lines.push(`| Namespace | ${report.moleculerConfig.namespace} |`);
  lines.push("");

  // ── 3. Baseline Call Test ──
  lines.push("## 3. Baseline Call Test Results");
  lines.push("");
  const ct = report.callTestResults;
  lines.push(`- **Total calls:** ${ct.totalCalls}`);
  lines.push(`- **Responders hit:** ${ct.respondersHit.join(", ")}`);
  lines.push(`- **Distributed:** ${ct.distributed ? "YES" : "NO"}`);
  lines.push("");
  lines.push("| Worker Node | Calls Handled |");
  lines.push("|-------------|---------------|");
  for (const [node, count] of Object.entries(ct.countsPerResponder)) {
    lines.push(`| ${node} | ${count} |`);
  }
  lines.push("");

  // ── 4. Baseline Broadcast Test ──
  lines.push("## 4. Baseline Broadcast Test Results");
  lines.push("");
  for (const bt of report.broadcastTestResults) {
    lines.push(`### Broadcast ${bt.correlationId.slice(0, 8)}...`);
    lines.push("");
    lines.push(`- **Expected:** ${bt.expectedListeners.join(", ")}`);
    lines.push(`- **Actual:** ${bt.actualListeners.join(", ")}`);
    lines.push(`- **Missing:** ${bt.missingListeners.length > 0 ? bt.missingListeners.join(", ") : "none"}`);
    lines.push(`- **All received:** ${bt.allReceived ? "YES" : "NO"}`);
    lines.push("");
  }

  // ── 5. NATS Evidence ──
  lines.push("## 5. NATS Subscription Evidence");
  lines.push("");
  const ne = report.natsEvidence;
  if (ne.queueGroups.length > 0) {
    lines.push("### Queue Groups");
    lines.push("");
    for (const qg of ne.queueGroups.slice(0, 15)) {
      lines.push(`- \`${qg}\``);
    }
    lines.push("");
  }
  lines.push("### Interpretation");
  lines.push("");
  lines.push(ne.interpretation);
  lines.push("");

  // ── 6. Churn Test Results ──
  if (report.churnTestResults) {
    lines.push("## 6. Churn / Stale-Registry Stress Test Results");
    lines.push("");
    generateChurnSection(lines, report.churnTestResults);
  }

  // ── 7. Scale Test Results ──
  if (report.scaleTestResults) {
    lines.push("## 7. Scale / Transport-Load Stress Test Results");
    lines.push("");
    generateScaleSection(lines, report.scaleTestResults);
  }

  // ── 8. Hypothesis Conclusions ──
  const sectionNum = 6 + (report.churnTestResults ? 1 : 0) + (report.scaleTestResults ? 1 : 0);
  lines.push(`## ${sectionNum}. Hypothesis Conclusions`);
  lines.push("");
  for (const h of report.hypotheses) {
    const icon = h.passed ? "PASS" : "FAIL";
    lines.push(`### ${h.id}: ${icon}`);
    lines.push("");
    lines.push(`**${h.description}**`);
    lines.push("");
    lines.push(`- **Result:** ${h.passed ? "PASSED" : "FAILED"}`);
    lines.push(`- **Confidence:** ${h.confidence}`);
    lines.push("");
    lines.push("**Evidence:**");
    for (const e of h.evidence) {
      lines.push(`- ${e}`);
    }
    lines.push("");
    if (h.caveats.length > 0) {
      lines.push("**Caveats:**");
      for (const c of h.caveats) {
        lines.push(`- ${c}`);
      }
      lines.push("");
    }
  }

  // ── Expected vs Actual (control mode) ──
  if (report.controlMode && report.expectedOutcomes) {
    lines.push("## Expected vs Actual Outcomes (Control Experiment)");
    lines.push("");
    lines.push("In control mode (`disableBalancer=false`), we expect only H4 to fail (local call");
    lines.push("short-circuiting). All other hypotheses should still pass — calls succeed via retries,");
    lines.push("but with higher latency during churn. The test PASSES overall if all expectations are met.");
    lines.push("");
    lines.push("| Hypothesis | Expected | Actual | Match | Reason |");
    lines.push("|------------|----------|--------|-------|--------|");
    for (const exp of report.expectedOutcomes) {
      const actual = report.hypotheses.find((h) => h.id === exp.id);
      const actualLabel = actual ? (actual.passed ? "PASS" : "FAIL") : "N/A";
      const expectedLabel = exp.expectedPass ? "PASS" : "FAIL";
      const match = actual
        ? (actual.passed === exp.expectedPass ? "OK" : "**MISMATCH**")
        : "N/A";
      const reason = exp.reason.length > 80 ? exp.reason.slice(0, 77) + "..." : exp.reason;
      lines.push(`| ${exp.id} | ${expectedLabel} | ${actualLabel} | ${match} | ${reason} |`);
    }
    lines.push("");

    const mismatches = report.expectedOutcomes.filter((exp) => {
      const actual = report.hypotheses.find((h) => h.id === exp.id);
      return actual && actual.passed !== exp.expectedPass;
    });

    if (mismatches.length === 0) {
      lines.push("**All expectations met.** The behavioral differences confirm that `disableBalancer=true` is responsible for NATS-driven routing and churn resilience.");
    } else {
      lines.push(`**${mismatches.length} expectation(s) not met.** The following hypotheses did not behave as predicted:`);
      for (const m of mismatches) {
        const actual = report.hypotheses.find((h) => h.id === m.id);
        lines.push(`- ${m.id}: expected ${m.expectedPass ? "PASS" : "FAIL"}, got ${actual?.passed ? "PASS" : "FAIL"}`);
      }
    }
    lines.push("");
  }

  // ── Overall Result ──
  lines.push("## Overall Result");
  lines.push("");
  if (report.controlMode) {
    lines.push(`**${report.overallPass ? "CONTROL EXPERIMENT PASSED — ALL EXPECTATIONS MET" : "CONTROL EXPERIMENT — UNEXPECTED RESULTS"}**`);
    lines.push("");
    lines.push("In control mode, \"pass\" means all expectations were met: H4 failed as expected (local");
    lines.push("call short-circuiting) and all other hypotheses passed. The real difference between modes");
    lines.push("is not pass/fail but latency — during churn, calls hit 15s timeouts on stale registry");
    lines.push("entries and require retries, making the suite significantly slower.");
  } else {
    lines.push(`**${report.overallPass ? "ALL KEY HYPOTHESES PASSED" : "SOME HYPOTHESES FAILED"}**`);
  }
  lines.push("");

  const passCount = report.hypotheses.filter((h) => h.passed).length;
  const failCount = report.hypotheses.filter((h) => !h.passed).length;
  lines.push(`- ${passCount} hypothesis(es) PASSED`);
  lines.push(`- ${failCount} hypothesis(es) FAILED`);
  lines.push("");

  return lines.join("\n");
}

function generateChurnSection(lines: string[], cr: ChurnTestSuiteResult): void {
  // Restart waves
  lines.push("### Restart Waves");
  lines.push("");
  lines.push("| Wave | Service | Action | Old Node IDs | New Node IDs | Time |");
  lines.push("|------|---------|--------|-------------|-------------|------|");
  for (const w of cr.waves) {
    const oldIds = w.oldNodeIds.length > 0 ? w.oldNodeIds.map((id) => id.slice(0, 20)).join(", ") : "(unknown)";
    const newIds = w.newNodeIds.length > 0 ? w.newNodeIds.map((id) => id.slice(0, 20)).join(", ") : "(pending)";
    lines.push(`| ${w.waveNumber} | ${w.serviceName} | ${w.action} | ${oldIds} | ${newIds} | ${w.timestamp.slice(11, 19)} |`);
  }
  lines.push("");

  // Call results during churn
  lines.push("### A1: Call Routing Under Churn");
  lines.push("");
  const callR = cr.callResults;
  lines.push(`- **Total calls:** ${callR.totalCalls} (${callR.successfulCalls} success, ${callR.failedCalls} failed)`);
  lines.push(`- **Success rate:** ${callR.totalCalls > 0 ? ((callR.successfulCalls / callR.totalCalls) * 100).toFixed(1) : 0}%`);
  lines.push(`- **Distinct handler node IDs:** ${callR.handlerNodeIds.length}`);
  lines.push("");
  lines.push("**Call distribution:**");
  lines.push("");
  lines.push("| Handler Node ID | Calls |");
  lines.push("|-----------------|-------|");
  for (const [nodeId, count] of Object.entries(callR.distribution)) {
    lines.push(`| ${nodeId.slice(0, 30)} | ${count} |`);
  }
  lines.push("");
  lines.push("**Latency:**");
  lines.push("");
  lines.push(formatLatencyStats(callR.latencyStats));
  lines.push("");

  if (callR.failures.length > 0) {
    lines.push(`**Failures (${callR.failures.length}):**`);
    for (const f of callR.failures.slice(0, 10)) {
      lines.push(`- [${f.phase}] ${f.error}`);
    }
    if (callR.failures.length > 10) {
      lines.push(`- ... and ${callR.failures.length - 10} more`);
    }
    lines.push("");
  }

  // Broadcast results during churn
  lines.push("### A2: Broadcast Routing Under Listener Churn");
  lines.push("");
  const bcR = cr.broadcastResults;
  lines.push(`- **Broadcasts sent:** ${bcR.totalBroadcasts}`);
  lines.push(`- **Overall delivery rate:** ${(bcR.overallDeliveryRate * 100).toFixed(1)}%`);
  lines.push("");
  for (const b of bcR.results) {
    lines.push(`**Broadcast ${b.correlationId.slice(0, 8)}:**`);
    lines.push(`- Sent at: ${b.sentAt}`);
    lines.push(`- Expected: ${b.expectedLiveListeners.join(", ") || "(none tracked)"}`);
    lines.push(`- Actual: ${b.actualReceivers.map((r) => r.slice(0, 25)).join(", ") || "(none)"}`);
    lines.push(`- Missing: ${b.missingReceivers.join(", ") || "none"}`);
    if (b.optionalReceivers.length > 0) {
      lines.push(`- Optional (restarting): ${b.optionalReceivers.join(", ")}`);
    }
    lines.push("");
  }

  // Rapid restart
  lines.push("### A3: Rapid Restart Cadence");
  lines.push("");
  const rrR = cr.rapidRestartResults;
  lines.push(`- **Total calls:** ${rrR.totalCalls} (${rrR.successfulCalls} success, ${rrR.failedCalls} failed)`);
  lines.push(`- **Success rate:** ${rrR.totalCalls > 0 ? ((rrR.successfulCalls / rrR.totalCalls) * 100).toFixed(1) : 0}%`);
  lines.push(`- **Distinct handler node IDs:** ${rrR.handlerNodeIds.length}`);
  lines.push("");
  lines.push("**Latency:**");
  lines.push("");
  lines.push(formatLatencyStats(rrR.latencyStats));
  lines.push("");

  // Stale-ID evidence
  lines.push("### A4: Stale-ID Evidence");
  lines.push("");
  const si = cr.staleIdEvidence;
  lines.push(`- **Dead (obsolete) node IDs:** ${si.deadNodeIds.length}`);
  if (si.deadNodeIds.length > 0) {
    for (const id of si.deadNodeIds.slice(0, 10)) {
      lines.push(`  - ${id}`);
    }
  }
  lines.push(`- **Live (current) node IDs:** ${si.liveNodeIds.length}`);
  if (si.liveNodeIds.length > 0) {
    for (const id of si.liveNodeIds.slice(0, 10)) {
      lines.push(`  - ${id}`);
    }
  }
  lines.push(`- **Transitions:** ${si.transitionEvents.length}`);
  lines.push("");
  lines.push(`**Conclusion:** ${si.conclusion}`);
  lines.push("");

  // Node ID timeline
  lines.push("### Node ID Timeline");
  lines.push("");
  lines.push("| Time | Event | Active Node IDs |");
  lines.push("|------|-------|-----------------|");
  for (const entry of cr.nodeIdTimeline) {
    const ids = entry.activeNodeIds.map((id) => id.slice(0, 20)).join(", ") || "(none)";
    lines.push(`| ${entry.timestamp.slice(11, 23)} | ${entry.event} | ${ids} |`);
  }
  lines.push("");

  // NATS snapshots
  lines.push("### NATS Monitoring Snapshots");
  lines.push("");
  lines.push("| Label | Time | Connections | Subscriptions |");
  lines.push("|-------|------|-------------|---------------|");
  for (const snap of cr.natsSnapshots) {
    lines.push(`| ${snap.label} | ${snap.timestamp.slice(11, 23)} | ${snap.connectionCount} | ${snap.subscriptionCount} |`);
  }
  lines.push("");
}

function generateScaleSection(lines: string[], sr: ScaleTestSuiteResult): void {
  lines.push("### Scale Configuration");
  lines.push("");
  lines.push(`- **Workers:** ${sr.workerCount}`);
  lines.push(`- **Listeners:** ${sr.listenerCount}`);
  lines.push(`- **Churn pattern:** ${sr.churnPattern}`);
  lines.push("");

  lines.push("### Latency Comparison");
  lines.push("");
  lines.push("| Phase | Avg (ms) | p50 (ms) | p95 (ms) | Min (ms) | Max (ms) | Success Rate |");
  lines.push("|-------|----------|----------|----------|----------|----------|-------------|");
  for (const [label, stats] of [
    ["Before Churn", sr.latencyBefore],
    ["During Churn", sr.latencyDuring],
    ["After Churn", sr.latencyAfter],
  ] as [string, LatencyStats][]) {
    lines.push(
      `| ${label} | ${stats.avgMs} | ${stats.p50Ms} | ${stats.p95Ms} | ${stats.minMs} | ${stats.maxMs} | ${(stats.successRate * 100).toFixed(0)}% |`,
    );
  }
  lines.push("");

  lines.push("### Delivery Metrics");
  lines.push("");
  lines.push(`- **Call success rate:** ${(sr.callSuccessRate * 100).toFixed(1)}%`);
  lines.push(`- **Broadcast delivery rate:** ${(sr.broadcastDeliveryRate * 100).toFixed(1)}%`);
  lines.push("");

  // NATS snapshots
  lines.push("### NATS Monitoring Snapshots");
  lines.push("");
  lines.push("| Label | Time | Connections | Subscriptions |");
  lines.push("|-------|------|-------------|---------------|");
  for (const snap of sr.natsSnapshots) {
    lines.push(`| ${snap.label} | ${snap.timestamp.slice(11, 23)} | ${snap.connectionCount} | ${snap.subscriptionCount} |`);
  }
  lines.push("");
}

export function saveReport(report: ValidationReport): void {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const mdContent = generateMarkdownReport(report);
  fs.writeFileSync(path.join(OUTPUT_DIR, "report.md"), mdContent);
  fs.writeFileSync(
    path.join(OUTPUT_DIR, "report.json"),
    JSON.stringify(report, null, 2),
  );

  console.log("");
  console.log("=".repeat(60));
  console.log(mdContent);
  console.log("=".repeat(60));
  console.log("");
  console.log(`Reports saved to:`);
  console.log(`  ${path.join(OUTPUT_DIR, "report.md")}`);
  console.log(`  ${path.join(OUTPUT_DIR, "report.json")}`);
}
