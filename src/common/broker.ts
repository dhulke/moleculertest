import { ServiceBroker, BrokerOptions } from "moleculer";
import { structuredLog } from "./logger";

export function createBroker(nodeId?: string): ServiceBroker {
  const natsUrl = process.env.NATS_URL || "nats://localhost:4222";
  const namespace = process.env.NAMESPACE || "demo";
  const disableBalancer = process.env.DISABLE_BALANCER !== "false";

  let resolvedNodeId: string;
  if (nodeId) {
    resolvedNodeId = nodeId;
  } else if (process.env.DYNAMIC_NODE_ID === "true") {
    const prefix = process.env.NODE_ID_PREFIX || "dyn";
    const ts = Date.now();
    const rand = Math.random().toString(36).substring(2, 8);
    resolvedNodeId = `${prefix}-${ts}-${rand}`;
  } else {
    resolvedNodeId = process.env.NODE_ID || `node-${process.pid}`;
  }

  process.env.NODE_ID = resolvedNodeId;

  const options: BrokerOptions = {
    nodeID: resolvedNodeId,
    namespace,
    transporter: {
      type: "NATS",
      options: {
        url: natsUrl,
        name: resolvedNodeId,
        maxReconnectAttempts: 30,
        reconnectTimeWait: 2000,
      },
    },
    disableBalancer,
    requestTimeout: 15000,
    retryPolicy: {
      enabled: true,
      retries: 3,
      delay: 500,
      maxDelay: 3000,
    },
    logger: {
      type: "Console",
      options: {
        level: "info",
        formatter: "short",
      },
    },
    metadata: {
      nodeId: resolvedNodeId,
      role: process.env.NODE_ROLE || "unknown",
      startedAt: new Date().toISOString(),
      dynamicId: process.env.DYNAMIC_NODE_ID === "true",
      prefix: process.env.NODE_ID_PREFIX || "",
    },
    tracking: {
      enabled: true,
      shutdownTimeout: 5000,
    },
  };

  structuredLog({
    event: "broker-config",
    nodeId: resolvedNodeId,
    namespace,
    transporter: "NATS",
    natsUrl,
    disableBalancer,
    dynamicId: process.env.DYNAMIC_NODE_ID === "true",
  });

  return new ServiceBroker(options);
}
