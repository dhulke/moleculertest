import { ServiceSchema, Context } from "moleculer";
import { structuredLog, appendEvidence, ensureOutputDir } from "../common/logger";
import { BroadcastTestPayload } from "../common/types";
import { v4 as uuidv4 } from "uuid";

const broadcasterService: ServiceSchema = {
  name: "broadcaster",

  created() {
    ensureOutputDir();
  },

  actions: {
    sendBroadcast: {
      params: {
        message: { type: "string", default: "test-broadcast", optional: true },
      },
      async handler(ctx: Context<{ message?: string }>): Promise<{
        correlationId: string;
        sentAt: string;
        sentBy: string;
      }> {
        const correlationId = uuidv4();
        const sentAt = new Date().toISOString();
        const sentBy = this.broker.nodeID;

        const payload: BroadcastTestPayload = {
          correlationId,
          sentBy,
          sentAt,
          message: ctx.params.message || "test-broadcast",
        };

        structuredLog({
          event: "broadcast-sending",
          correlationId,
          sentBy,
        });

        this.broker.broadcast("demo.broadcast", payload);

        appendEvidence("broadcast-send-log.jsonl", {
          event: "broadcast-sent",
          correlationId,
          sentBy,
          sentAt,
        });

        return { correlationId, sentAt, sentBy };
      },
    },

    sendMultipleBroadcasts: {
      params: {
        count: { type: "number", default: 3, optional: true },
      },
      async handler(ctx: Context<{ count?: number }>): Promise<{
        correlationIds: string[];
      }> {
        const count = ctx.params.count || 3;
        const correlationIds: string[] = [];

        for (let i = 0; i < count; i++) {
          const result = await ctx.call<{ correlationId: string }, { message: string }>(
            "broadcaster.sendBroadcast",
            { message: `broadcast-${i + 1}` },
          );
          correlationIds.push(result.correlationId);
          await new Promise((r) => setTimeout(r, 200));
        }

        return { correlationIds };
      },
    },
  },

  started() {
    structuredLog({
      event: "service-started",
      service: "broadcaster",
      nodeId: this.broker.nodeID,
    });
  },
};

export default broadcasterService;
