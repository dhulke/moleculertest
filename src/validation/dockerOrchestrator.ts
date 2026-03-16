import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { NatsSnapshot } from "../common/types";
import { fetchNatsConnz, fetchNatsSubsz } from "./collectNatsInfo";

const OUTPUT_DIR = process.env.OUTPUT_DIR || "./output";

function exec(cmd: string, ignoreErrors = false): string {
  try {
    return execSync(cmd, {
      encoding: "utf-8",
      cwd: process.cwd(),
      timeout: 120000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (err: any) {
    if (ignoreErrors) {
      return err.stdout?.trim?.() || "";
    }
    console.error(`[Docker] Command failed: ${cmd}`);
    console.error(`[Docker] stderr: ${err.stderr?.trim?.() || err.message}`);
    throw err;
  }
}

export function dockerCompose(args: string, ignoreErrors = false): string {
  return exec(`docker compose ${args}`, ignoreErrors);
}

export function restartService(name: string): void {
  console.log(`[Docker] Restarting service: ${name}`);
  dockerCompose(`--profile churn --profile scale restart -t 2 ${name}`);
}

export function stopService(name: string): void {
  console.log(`[Docker] Stopping service: ${name}`);
  dockerCompose(`--profile churn --profile scale stop -t 2 ${name}`, true);
}

export function startService(name: string): void {
  console.log(`[Docker] Starting service: ${name}`);
  dockerCompose(`--profile churn --profile scale up -d ${name}`);
}

export function startChurnServices(): void {
  console.log("[Docker] Starting churn services...");
  dockerCompose("--profile churn up -d");
}

export function stopChurnServices(): void {
  console.log("[Docker] Stopping churn services...");
  const services = [
    "churn-worker-1", "churn-worker-2", "churn-worker-3",
    "churn-listener-1", "churn-listener-2", "churn-listener-3", "churn-listener-4",
  ];
  dockerCompose(`--profile churn stop -t 2 ${services.join(" ")}`, true);
}

export function startScaleServices(workers: number, listeners: number): void {
  console.log(`[Docker] Starting scale services: ${workers} workers, ${listeners} listeners...`);
  dockerCompose(
    `--profile scale up -d --scale scale-worker=${workers} --scale scale-listener=${listeners}`,
  );
}

export function stopScaleServices(): void {
  console.log("[Docker] Stopping scale services...");
  dockerCompose("--profile scale stop -t 2 scale-worker scale-listener", true);
}

export function getScaleContainerIds(serviceName: string): string[] {
  const output = dockerCompose(
    `--profile scale ps -q ${serviceName}`,
    true,
  );
  if (!output) return [];
  return output.split("\n").filter((id) => id.length > 0);
}

export function killContainers(containerIds: string[]): void {
  if (containerIds.length === 0) return;
  console.log(`[Docker] Killing ${containerIds.length} containers...`);
  exec(`docker kill ${containerIds.join(" ")}`, true);
}

export function killRandomContainers(serviceName: string, count: number): string[] {
  const ids = getScaleContainerIds(serviceName);
  const shuffled = ids.sort(() => Math.random() - 0.5);
  const toKill = shuffled.slice(0, Math.min(count, ids.length));
  killContainers(toKill);
  return toKill;
}

export async function discoverNodeIdsFromNats(prefixes?: string[]): Promise<string[]> {
  try {
    const connz = await fetchNatsConnz();
    if (!connz.connections) return [];
    const names = connz.connections
      .map((c: any) => c.name)
      .filter((n: string) => n && n.length > 0);
    if (!prefixes || prefixes.length === 0) return names;
    return names.filter((name: string) =>
      prefixes.some((p) => name.startsWith(p)),
    );
  } catch {
    return [];
  }
}

export async function discoverNodeIdsByPrefix(prefix: string): Promise<string[]> {
  return discoverNodeIdsFromNats([prefix]);
}

export async function waitForNatsConnections(
  expectedMinimum: number,
  prefixes: string[],
  timeoutMs = 30000,
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  let lastFound: string[] = [];

  while (Date.now() < deadline) {
    lastFound = await discoverNodeIdsFromNats(prefixes);
    if (lastFound.length >= expectedMinimum) {
      return lastFound;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  console.warn(
    `[Docker] Timeout waiting for ${expectedMinimum} connections with prefixes [${prefixes.join(",")}]. Found ${lastFound.length}: ${lastFound.join(", ")}`,
  );
  return lastFound;
}

export async function waitForReadinessFiles(
  prefixes: string[],
  expectedCount: number,
  timeoutMs = 30000,
): Promise<Array<{ nodeId: string; role: string; prefix: string }>> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const found = readReadinessFiles(prefixes);
    if (found.length >= expectedCount) {
      return found;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  return readReadinessFiles(prefixes);
}

export function readReadinessFiles(
  prefixes?: string[],
): Array<{ nodeId: string; role: string; prefix: string; timestamp: string }> {
  try {
    const files = fs.readdirSync(OUTPUT_DIR).filter(
      (f) => f.startsWith("node-ready-") && f.endsWith(".json"),
    );
    const results: Array<{ nodeId: string; role: string; prefix: string; timestamp: string }> = [];
    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(OUTPUT_DIR, file), "utf-8");
        const data = JSON.parse(content);
        if (prefixes && prefixes.length > 0) {
          if (!prefixes.some((p) => data.nodeId?.startsWith(p) || data.prefix?.startsWith(p))) {
            continue;
          }
        }
        results.push(data);
      } catch {}
    }
    return results;
  } catch {
    return [];
  }
}

export function clearReadinessFiles(prefixes?: string[]): void {
  try {
    const files = fs.readdirSync(OUTPUT_DIR).filter(
      (f) => f.startsWith("node-ready-") && f.endsWith(".json"),
    );
    for (const file of files) {
      if (prefixes && prefixes.length > 0) {
        const matchesPrefix = prefixes.some((p) => file.includes(p));
        if (!matchesPrefix) continue;
      }
      fs.unlinkSync(path.join(OUTPUT_DIR, file));
    }
  } catch {}
}

export function clearBroadcastReceiptFiles(prefixes?: string[]): void {
  try {
    const files = fs.readdirSync(OUTPUT_DIR).filter(
      (f) => f.startsWith("broadcast-receipt-") && f.endsWith(".jsonl"),
    );
    for (const file of files) {
      if (prefixes && prefixes.length > 0) {
        const matchesPrefix = prefixes.some((p) => file.includes(p));
        if (!matchesPrefix) continue;
      }
      fs.unlinkSync(path.join(OUTPUT_DIR, file));
    }
  } catch {}
}

export function readBroadcastReceiptFiles(prefixes?: string[]): any[] {
  const evidence: any[] = [];
  try {
    const files = fs.readdirSync(OUTPUT_DIR).filter(
      (f) => f.startsWith("broadcast-receipt-") && f.endsWith(".jsonl"),
    );
    for (const file of files) {
      if (prefixes && prefixes.length > 0) {
        const matchesPrefix = prefixes.some((p) => file.includes(p));
        if (!matchesPrefix) continue;
      }
      const content = fs.readFileSync(path.join(OUTPUT_DIR, file), "utf-8");
      const lines = content.trim().split("\n").filter((l) => l.length > 0);
      for (const line of lines) {
        try {
          evidence.push(JSON.parse(line));
        } catch {}
      }
    }
  } catch {}
  return evidence;
}

export async function takeNatsSnapshot(label: string, subdir?: string): Promise<NatsSnapshot> {
  const ts = new Date().toISOString();
  const dir = subdir ? path.join(OUTPUT_DIR, subdir) : OUTPUT_DIR;
  fs.mkdirSync(dir, { recursive: true });

  const [connz, subsz] = await Promise.all([
    fetchNatsConnz().catch(() => ({ num_connections: 0 })),
    fetchNatsSubsz().catch(() => ({ num_subscriptions: 0 })),
  ]);

  const filename = `nats-snapshot-${label}.json`;
  fs.writeFileSync(
    path.join(dir, filename),
    JSON.stringify({ label, timestamp: ts, connz, subsz }, null, 2),
  );

  return {
    label,
    timestamp: ts,
    connectionCount: connz.num_connections || 0,
    subscriptionCount: subsz.num_subscriptions || 0,
    filename: subdir ? `${subdir}/${filename}` : filename,
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
