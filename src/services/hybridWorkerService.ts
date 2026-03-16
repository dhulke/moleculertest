import { ServiceSchema, Context } from "moleculer";
import { structuredLog, appendEvidence, ensureOutputDir } from "../common/logger";
import { CallEvidence, CallTestPayload } from "../common/types";
import * as os from "os";
import { v4 as uuidv4 } from "uuid";

const hybridWorkerService: ServiceSchema = {
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
          event: "hybrid-action-handled",
          ...evidence,
          requestSequence: ctx.params.sequenceNumber,
          requestFrom: ctx.params.sentBy,
          isLocalCall: ctx.params.sentBy === nodeId,
        });

        appendEvidence("hybrid-call-evidence.jsonl", evidence);

        return evidence;
      },
    },
  },

  started() {
    structuredLog({
      event: "service-started",
      service: "workers (hybrid)",
      nodeId: this.broker.nodeID,
    });
  },
};

const hybridCallerService: ServiceSchema = {
  name: "hybridCaller",

  created() {
    ensureOutputDir();
  },

  actions: {
    runLocalTest: {
      params: {
        count: { type: "number", default: 10, optional: true },
      },
      async handler(ctx: Context<{ count?: number }>): Promise<{
        totalCalls: number;
        results: CallEvidence[];
        distribution: Record<string, number>;
        localNodeId: string;
      }> {
        const count = ctx.params.count || 10;
        const results: CallEvidence[] = [];
        const distribution: Record<string, number> = {};
        const localNodeId = this.broker.nodeID;

        structuredLog({
          event: "hybrid-local-test-start",
          totalCalls: count,
          nodeId: localNodeId,
        });

        for (let i = 0; i < count; i++) {
          const correlationId = uuidv4();
          const payload: CallTestPayload = {
            correlationId,
            sequenceNumber: i + 1,
            sentBy: localNodeId,
            sentAt: new Date().toISOString(),
          };

          try {
            const result = await ctx.call<CallEvidence, CallTestPayload>("workers.process", payload);
            results.push(result);
            distribution[result.handlerNodeId] = (distribution[result.handlerNodeId] || 0) + 1;

            appendEvidence("hybrid-call-test-log.jsonl", {
              event: "hybrid-call-result",
              sequenceNumber: i + 1,
              correlationId,
              callerNode: localNodeId,
              respondedBy: result.handlerNodeId,
              wasLocal: result.handlerNodeId === localNodeId,
            });
          } catch (err: any) {
            structuredLog({
              event: "hybrid-call-error",
              sequenceNumber: i + 1,
              correlationId,
              error: err.message,
            });
          }

          await new Promise((r) => setTimeout(r, 50));
        }

        structuredLog({
          event: "hybrid-local-test-complete",
          totalCalls: count,
          successfulCalls: results.length,
          distribution,
          localNodeId,
        });

        return { totalCalls: count, results, distribution, localNodeId };
      },
    },
  },

  started() {
    structuredLog({
      event: "service-started",
      service: "hybridCaller",
      nodeId: this.broker.nodeID,
    });
  },
};

export { hybridWorkerService, hybridCallerService };
