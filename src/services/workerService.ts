import { ServiceSchema, Context } from "moleculer";
import { structuredLog, appendEvidence, ensureOutputDir } from "../common/logger";
import { CallEvidence, CallTestPayload } from "../common/types";
import * as os from "os";

const workerService: ServiceSchema = {
  name: "workers",

  created() {
    ensureOutputDir();
  },

  actions: {
    process: {
      params: {
        correlationId: "string",
        sequenceNumber: "number",
        sentBy: "string",
        sentAt: "string",
      },
      handler(ctx: Context<CallTestPayload>): CallEvidence {
        const nodeId = this.broker.nodeID;
        const evidence: CallEvidence = {
          type: "call-response",
          correlationId: ctx.params.correlationId,
          actionName: "workers.process",
          handlerNodeId: nodeId,
          handlerServiceName: "workers",
          timestamp: new Date().toISOString(),
          pid: process.pid,
          hostname: os.hostname(),
        };

        structuredLog({
          event: "action-handled",
          ...evidence,
          requestSequence: ctx.params.sequenceNumber,
          requestFrom: ctx.params.sentBy,
        });

        appendEvidence("call-evidence.jsonl", evidence);

        return evidence;
      },
    },

    getEvidence: {
      handler(_ctx: Context) {
        return { nodeId: this.broker.nodeID, role: "worker", status: "ready" };
      },
    },
  },

  started() {
    structuredLog({
      event: "service-started",
      service: "workers",
      nodeId: this.broker.nodeID,
    });
  },
};

export default workerService;
