import { createBroker } from "../common/broker";
import { structuredLog, writeReadinessFile } from "../common/logger";
import workerService from "../services/workerService";

async function main() {
  const broker = createBroker();
  broker.createService(workerService);

  try {
    await broker.start();
    writeReadinessFile(broker.nodeID, process.env.NODE_ROLE || "worker");
    structuredLog({
      event: "node-ready",
      nodeId: broker.nodeID,
      role: "worker",
      services: ["workers"],
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
