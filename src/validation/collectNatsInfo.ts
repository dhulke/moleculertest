import * as http from "http";
import * as fs from "fs";
import * as path from "path";

const NATS_MONITOR_URL = process.env.NATS_MONITOR_URL || "http://localhost:8222";
const OUTPUT_DIR = process.env.OUTPUT_DIR || "./output";

function httpGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(data));
      res.on("error", reject);
    }).on("error", reject);
  });
}

export async function fetchNatsSubsz(): Promise<any> {
  const raw = await httpGet(`${NATS_MONITOR_URL}/subsz?subs=1&limit=1000`);
  return JSON.parse(raw);
}

export async function fetchNatsConnz(): Promise<any> {
  const raw = await httpGet(`${NATS_MONITOR_URL}/connz?subs=1`);
  return JSON.parse(raw);
}

export async function fetchNatsVarz(): Promise<any> {
  const raw = await httpGet(`${NATS_MONITOR_URL}/varz`);
  return JSON.parse(raw);
}

export async function fetchNatsRoutez(): Promise<any> {
  const raw = await httpGet(`${NATS_MONITOR_URL}/routez`);
  return JSON.parse(raw);
}

export async function collectAndSaveNatsInfo(subdir?: string): Promise<{
  subsz: any;
  connz: any;
  varz: any;
}> {
  const dir = subdir ? path.join(OUTPUT_DIR, subdir) : OUTPUT_DIR;
  fs.mkdirSync(dir, { recursive: true });

  const [subsz, connz, varz] = await Promise.all([
    fetchNatsSubsz(),
    fetchNatsConnz(),
    fetchNatsVarz(),
  ]);

  fs.writeFileSync(path.join(dir, "nats-subsz.json"), JSON.stringify(subsz, null, 2));
  fs.writeFileSync(path.join(dir, "nats-connz.json"), JSON.stringify(connz, null, 2));
  fs.writeFileSync(path.join(dir, "nats-varz.json"), JSON.stringify(varz, null, 2));

  console.log(`[NATS] Saved monitoring snapshots to ${dir}/`);
  return { subsz, connz, varz };
}

export async function collectLabeledSnapshot(label: string, subdir?: string): Promise<{
  label: string;
  timestamp: string;
  connz: any;
  subsz: any;
}> {
  const dir = subdir ? path.join(OUTPUT_DIR, subdir) : OUTPUT_DIR;
  fs.mkdirSync(dir, { recursive: true });

  const [connz, subsz] = await Promise.all([
    fetchNatsConnz().catch(() => ({ num_connections: 0, connections: [] })),
    fetchNatsSubsz().catch(() => ({ num_subscriptions: 0 })),
  ]);

  const ts = new Date().toISOString();
  fs.writeFileSync(
    path.join(dir, `nats-${label}.json`),
    JSON.stringify({ label, timestamp: ts, connz, subsz }, null, 2),
  );

  return { label, timestamp: ts, connz, subsz };
}

export function analyzeNatsSubscriptions(connz: any, subsz?: any): {
  relevantSubjects: string[];
  queueGroups: string[];
  nodeTargetedSubjects: string[];
  actionSubjects: string[];
  eventSubjects: string[];
  allSubscriptions: Array<{ client: string; subject: string; qgroup?: string }>;
} {
  const allSubs: Array<{ client: string; subject: string; qgroup?: string }> = [];
  const subjectSet = new Set<string>();
  const queueGroupSet = new Set<string>();
  const nodeTargeted: string[] = [];
  const actionSubs: string[] = [];
  const eventSubs: string[] = [];

  if (connz.connections) {
    for (const conn of connz.connections) {
      const clientName = conn.name || `cid-${conn.cid}`;
      if (conn.subscriptions_list) {
        for (const sub of conn.subscriptions_list) {
          const parts = sub.split(" ");
          const subject = parts[0];
          allSubs.push({ client: clientName, subject });
          subjectSet.add(subject);
        }
      }
    }
  }

  if (subsz && subsz.subscriptions_list) {
    for (const sub of subsz.subscriptions_list) {
      const subject = sub.subject;
      if (!subject) continue;
      subjectSet.add(subject);

      if (sub.qgroup) {
        queueGroupSet.add(`${subject} [queue: ${sub.qgroup}]`);
        allSubs.push({ client: `cid-${sub.cid}`, subject, qgroup: sub.qgroup });
      }
    }
  }

  for (const subject of subjectSet) {
    if (subject.includes(".RES.") || subject.match(/\.REQ\.[^.]+$/)) {
      nodeTargeted.push(subject);
    }

    if (subject.includes(".REQB.")) {
      actionSubs.push(subject);
    } else if (subject.includes(".REQ.") && !subject.match(/\.REQ\.[^.]+$/)) {
      actionSubs.push(subject);
    }

    if (subject.includes(".EVENT.") || subject.includes(".EVENTB.")) {
      eventSubs.push(subject);
    }
  }

  return {
    relevantSubjects: [...subjectSet].filter(
      (s) => s.includes("demo.") || s.includes("MOL-demo"),
    ),
    queueGroups: [...queueGroupSet],
    nodeTargetedSubjects: [...new Set(nodeTargeted)],
    actionSubjects: [...new Set(actionSubs)],
    eventSubjects: [...new Set(eventSubs)],
    allSubscriptions: allSubs,
  };
}
