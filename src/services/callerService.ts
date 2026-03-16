import { ServiceSchema, Context } from "moleculer";
import { structuredLog, appendEvidence, ensureOutputDir } from "../common/logger";
import { CallEvidence, CallTestPayload } from "../common/types";
import { v4 as uuidv4 } from "uuid";

const callerService: ServiceSchema = {
  name: "caller",

  created() {
    ensureOutputDir();
  },

  actions: {
    runCallTest: {
      params: {
        count: { type: "number", default: 30, optional: true },
      },
      async handler(ctx: Context<{ count?: number }>): Promise<{
        totalCalls: number;
        results: CallEvidence[];
        distribution: Record<string, number>;
      }> {
        const count = ctx.params.count || 30;
        const results: CallEvidence[] = [];
        const distribution: Record<string, number> = {};

        structuredLog({
          event: "call-test-start",
          totalCalls: count,
          nodeId: this.broker.nodeID,
        });

        for (let i = 0; i < count; i++) {
          const correlationId = uuidv4();
          const payload: CallTestPayload = {
            correlationId,
            sequenceNumber: i + 1,
            sentBy: this.broker.nodeID,
            sentAt: new Date().toISOString(),
          };

          try {
            const result = await ctx.call<CallEvidence, CallTestPayload>("workers.process", payload);
            results.push(result);
            distribution[result.handlerNodeId] = (distribution[result.handlerNodeId] || 0) + 1;

            appendEvidence("call-test-log.jsonl", {
              event: "call-sent-and-responded",
              sequenceNumber: i + 1,
              correlationId,
              respondedBy: result.handlerNodeId,
            });
          } catch (err: any) {
            structuredLog({
              event: "call-test-error",
              sequenceNumber: i + 1,
              correlationId,
              error: err.message,
            });
          }

          await new Promise((r) => setTimeout(r, 50));
        }

        structuredLog({
          event: "call-test-complete",
          totalCalls: count,
          successfulCalls: results.length,
          distribution,
        });

        return { totalCalls: count, results, distribution };
      },
    },
  },

  started() {
    structuredLog({
      event: "service-started",
      service: "caller",
      nodeId: this.broker.nodeID,
    });
  },
};

export default callerService;
