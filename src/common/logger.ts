import * as fs from "fs";
import * as path from "path";

const OUTPUT_DIR = process.env.OUTPUT_DIR || "/app/output";

export function structuredLog(data: Record<string, any>): void {
  const entry = {
    ...data,
    _ts: new Date().toISOString(),
    _nodeId: process.env.NODE_ID || "unknown",
    _pid: process.pid,
  };
  console.log(JSON.stringify(entry));
}

export function appendEvidence(filename: string, data: Record<string, any>): void {
  const filePath = path.join(OUTPUT_DIR, filename);
  const line = JSON.stringify({
    ...data,
    _ts: new Date().toISOString(),
    _nodeId: process.env.NODE_ID || "unknown",
  });
  try {
    fs.appendFileSync(filePath, line + "\n");
  } catch (err) {
    console.error(`Failed to write evidence to ${filePath}:`, err);
  }
}

export function ensureOutputDir(): void {
  try {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  } catch {}
}

export function writeReadinessFile(nodeId: string, role: string): void {
  try {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const readyFile = path.join(OUTPUT_DIR, `node-ready-${nodeId}.json`);
    fs.writeFileSync(
      readyFile,
      JSON.stringify({
        nodeId,
        role,
        prefix: process.env.NODE_ID_PREFIX || "",
        timestamp: new Date().toISOString(),
        pid: process.pid,
      }),
    );
  } catch {}
}
