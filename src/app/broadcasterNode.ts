import { createBroker } from "../common/broker";
import { structuredLog, writeReadinessFile } from "../common/logger";
import broadcasterService from "../services/broadcasterService";
import listenerService from "../services/listenerService";

async function main() {
  const broker = createBroker();
  broker.createService(broadcasterService);
  broker.createService(listenerService);

  try {
    await broker.start();
    writeReadinessFile(broker.nodeID, process.env.NODE_ROLE || "broadcaster");
    structuredLog({
      event: "node-ready",
      nodeId: broker.nodeID,
      role: "broadcaster",
      services: ["broadcaster", "listener"],
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
