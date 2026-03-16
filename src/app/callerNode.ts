import { createBroker } from "../common/broker";
import { structuredLog, writeReadinessFile } from "../common/logger";
import callerService from "../services/callerService";

async function main() {
  const broker = createBroker();
  broker.createService(callerService);

  try {
    await broker.start();
    writeReadinessFile(broker.nodeID, process.env.NODE_ROLE || "caller");
    structuredLog({
      event: "node-ready",
      nodeId: broker.nodeID,
      role: "caller",
      services: ["caller"],
    });
  } catch (err: any) {
    structuredLog({ event: "node-start-error", error: err.message });
    process.exit(1);
  }

  const shutdown = async () => {
    structuredLog({ event: "node-stopping", nodeId: broker.nodeID });
    await broker.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
