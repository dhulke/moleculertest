export interface CallEvidence {
  type: "call-response";
  correlationId: string;
  actionName: string;
  handlerNodeId: string;
  handlerServiceName: string;
  timestamp: string;
  pid: number;
  hostname: string;
}

export interface BroadcastEvidence {
  type: "broadcast-receipt";
  correlationId: string;
  eventName: string;
  receiverNodeId: string;
  receiverServiceName: string;
  timestamp: string;
  pid: number;
  hostname: string;
}

export interface CallTestPayload {
  correlationId: string;
  sequenceNumber: number;
  sentBy: string;
  sentAt: string;
}

export interface BroadcastTestPayload {
  correlationId: string;
  sentBy: string;
  sentAt: string;
  message: string;
}

export interface EvidenceRecord {
  type: "call-response" | "broadcast-receipt";
  correlationId: string;
  nodeId: string;
  serviceName: string;
  actionOrEvent: string;
  timestamp: string;
}

export interface CallTestResult {
  totalCalls: number;
  respondersHit: string[];
  countsPerResponder: Record<string, number>;
  rawSamples: CallEvidence[];
  distributed: boolean;
}

export interface BroadcastTestResult {
  correlationId: string;
  expectedListeners: string[];
  actualListeners: string[];
  missingListeners: string[];
  duplicateListeners: string[];
  allReceived: boolean;
  rawReceipts: BroadcastEvidence[];
}

export interface NatsSubszData {
  num_subscriptions: number;
  num_cache: number;
  num_inserts: number;
  num_removes: number;
  num_matches: number;
  cache_hit_rate: number;
  max_fanout: number;
  avg_fanout: number;
  subscriptions_list?: NatsSubscription[];
}

export interface NatsSubscription {
  subject: string;
  qgroup?: string;
  sid: string;
  msgs: number;
  max?: number;
  cid: number;
  account?: string;
}

export interface NatsConnzData {
  server_id: string;
  now: string;
  num_connections: number;
  total: number;
  offset: number;
  limit: number;
  connections: NatsConnection[];
}

export interface NatsConnection {
  cid: number;
  kind: string;
  type: string;
  ip: string;
  port: number;
  name: string;
  lang: string;
  version: string;
  subscriptions: number;
  subscriptions_list?: string[];
}

export interface HypothesisResult {
  id: string;
  description: string;
  passed: boolean;
  confidence: "high" | "medium" | "low";
  evidence: string[];
  caveats: string[];
}

// --- Latency & measurement types ---

export interface LatencyMeasurement {
  phase: string;
  latencyMs: number;
  success: boolean;
  handlerNodeId?: string;
  error?: string;
  timestamp: string;
}

export interface LatencyStats {
  count: number;
  successCount: number;
  failureCount: number;
  successRate: number;
  minMs: number;
  maxMs: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
}

// --- Churn test types ---

export interface ChurnWave {
  waveNumber: number;
  serviceName: string;
  action: string;
  timestamp: string;
  durationMs: number;
  oldNodeIds: string[];
  newNodeIds: string[];
}

export interface NodeIdTimelineEntry {
  timestamp: string;
  event: string;
  activeNodeIds: string[];
}

export interface ChurnCallResult {
  totalCalls: number;
  successfulCalls: number;
  failedCalls: number;
  handlerNodeIds: string[];
  distribution: Record<string, number>;
  failures: Array<{
    correlationId: string;
    error: string;
    timestamp: string;
    phase: string;
  }>;
  latencyStats: LatencyStats;
}

export interface ChurnBroadcastSingleResult {
  correlationId: string;
  sentAt: string;
  expectedLiveListeners: string[];
  actualReceivers: string[];
  missingReceivers: string[];
  optionalReceivers: string[];
  allExpectedReceived: boolean;
}

export interface ChurnBroadcastResult {
  totalBroadcasts: number;
  results: ChurnBroadcastSingleResult[];
  overallDeliveryRate: number;
}

export interface NatsSnapshot {
  label: string;
  timestamp: string;
  connectionCount: number;
  subscriptionCount: number;
  filename: string;
}

export interface StaleIdEvidence {
  deadNodeIds: string[];
  liveNodeIds: string[];
  transitionEvents: Array<{
    oldId: string;
    newId: string;
    service: string;
    timestamp: string;
  }>;
  conclusion: string;
}

export interface ChurnTestSuiteResult {
  waves: ChurnWave[];
  nodeIdTimeline: NodeIdTimelineEntry[];
  callResults: ChurnCallResult;
  broadcastResults: ChurnBroadcastResult;
  rapidRestartResults: ChurnCallResult;
  natsSnapshots: NatsSnapshot[];
  staleIdEvidence: StaleIdEvidence;
}

// --- Scale test types ---

export interface ScaleTestSuiteResult {
  workerCount: number;
  listenerCount: number;
  latencyBefore: LatencyStats;
  latencyDuring: LatencyStats;
  latencyAfter: LatencyStats;
  callSuccessRate: number;
  broadcastDeliveryRate: number;
  churnPattern: string;
  natsSnapshots: NatsSnapshot[];
}

// --- Expected outcome for control experiments ---

export interface HypothesisExpectation {
  id: string;
  expectedPass: boolean;
  reason: string;
}

// --- Main report ---

export interface ValidationReport {
  timestamp: string;
  environment: {
    containers: string[];
    nodeIds: string[];
    serviceRoles: Record<string, string>;
  };
  moleculerConfig: {
    transporter: string;
    disableBalancer: boolean;
    namespace: string;
  };
  controlMode?: boolean;
  expectedOutcomes?: HypothesisExpectation[];
  callTestResults: CallTestResult;
  broadcastTestResults: BroadcastTestResult[];
  natsEvidence: {
    subsz: any;
    connz: any;
    relevantSubjects: string[];
    queueGroups: string[];
    nodeTargetedSubjects: string[];
    interpretation: string;
  };
  hypotheses: HypothesisResult[];
  overallPass: boolean;
  churnTestResults?: ChurnTestSuiteResult;
  scaleTestResults?: ScaleTestSuiteResult;
}
