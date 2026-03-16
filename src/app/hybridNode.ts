import { createBroker } from "../common/broker";
import { structuredLog, writeReadinessFile } from "../common/logger";
import { hybridWorkerService, hybridCallerService } from "../services/hybridWorkerService";
import listenerService from "../services/listenerService";

async function main() {
  const broker = createBroker();
  broker.createService(hybridWorkerService);
  broker.createService(hybridCallerService);
  broker.createService(listenerService);

  try {
    await broker.start();
    writeReadinessFile(broker.nodeID, process.env.NODE_ROLE || "hybrid");
    structuredLog({
      event: "node-ready",
      nodeId: broker.nodeID,
      role: "hybrid",
      services: ["workers", "hybridCaller", "listener"],
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
