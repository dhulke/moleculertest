import { ServiceSchema, Context } from "moleculer";
import { structuredLog, appendEvidence, ensureOutputDir } from "../common/logger";
import { BroadcastEvidence, BroadcastTestPayload } from "../common/types";
import * as os from "os";

const receivedBroadcasts: BroadcastEvidence[] = [];

const listenerService: ServiceSchema = {
  name: "listener",

  created() {
    ensureOutputDir();
  },

  events: {
    "demo.broadcast": {
      handler(ctx: Context<BroadcastTestPayload>) {
        const nodeId = this.broker.nodeID;
        const evidence: BroadcastEvidence = {
          type: "broadcast-receipt",
          correlationId: ctx.params.correlationId,
          eventName: "demo.broadcast",
          receiverNodeId: nodeId,
          receiverServiceName: "listener",
          timestamp: new Date().toISOString(),
          pid: process.pid,
          hostname: os.hostname(),
        };

        structuredLog({
          event: "broadcast-received",
          ...evidence,
          message: ctx.params.message,
          sentBy: ctx.params.sentBy,
        });

        receivedBroadcasts.push(evidence);
        appendEvidence("broadcast-evidence.jsonl", evidence);
        appendEvidence(`broadcast-receipt-${nodeId}.jsonl`, evidence);
      },
    },
  },

  actions: {
    ping: {
      handler(_ctx: Context) {
        return { nodeId: this.broker.nodeID, service: "listener", status: "ready" };
      },
    },

    getReceivedBroadcasts: {
      handler(_ctx: Context) {
        return {
          nodeId: this.broker.nodeID,
          broadcasts: receivedBroadcasts,
          count: receivedBroadcasts.length,
        };
      },
    },

    clearReceivedBroadcasts: {
      handler(_ctx: Context) {
        receivedBroadcasts.length = 0;
        return { nodeId: this.broker.nodeID, cleared: true };
      },
    },
  },

  started() {
    structuredLog({
      event: "service-started",
      service: "listener",
      nodeId: this.broker.nodeID,
    });
  },
};

export default listenerService;
