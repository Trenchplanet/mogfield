// Where the Comfy workflows run: Comfy Cloud (COMFY_API_KEY) or your own
// ComfyUI (a URL, e.g. a RunPod pod behind comfy-api-proxy). The choice is saved
// in data/backend.json and can change while the server runs. Seedance and other
// partner models always go through the Comfy API, whatever is picked here.

import { existsSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DATA_DIR, setComfyTarget } from "./config.js";
import { resetComfyClient, workflowPath } from "./engines/comfy.js";

export interface Backend {
  target: "cloud" | "custom";
  /** Your ComfyUI, e.g. http://127.0.0.1:8189 or https://<pod>-8189.proxy.runpod.net */
  url?: string;
}

/** Each feature and the API-format workflows it runs. */
export const FEATURES: readonly { id: string; label: string; workflows: readonly string[]; nodes?: readonly string[] }[] = [
  { id: "seedance", label: "Seedance: Restyle, Re-shoot, Text to video, Create", workflows: [], nodes: ["ByteDance2ReferenceNodeV2", "ByteDance2TextToVideoNode", "LoadVideo", "LoadImage", "SaveVideo"] },
  { id: "depth", label: "Depth maps", workflows: ["backlot_depth"] },
  { id: "prep", label: "Genjustsu prep (depth, vocals, SAM 3)", workflows: ["backlot_genjustsu", "backlot_genjustsu_sam"] },
  { id: "pika", label: "Pika H3 Flex (LOCAL only)", workflows: ["backlot_pika_h3_t2v", "backlot_pika_h3_fl2va", "backlot_pika_h3_ref2va"] },
  { id: "h3", label: "H3 character swap", workflows: ["backlot_h3_swap"] },
  { id: "cast", label: "Character cards (FLUX 3)", workflows: ["backlot_cast"] },
  { id: "direct", label: "Direct (camera, lens, grade)", workflows: ["backlot_direct"] },
  { id: "recast", label: "LTX 2.5 Recast (open weights)", workflows: ["backlot_recast"] },
];

export interface FeatureCheck {
  id: string;
  label: string;
  ok: boolean;
  /** Node classes the target does not have. */
  missingNodes: string[];
  /** Model or asset files a loader asks for that the target does not list. */
  missingFiles: string[];
  /** LoRA files the target lacks: the feature still runs without them (the app can skip a LoRA). */
  optionalFiles: string[];
  /** Workflow files not in workflows/. */
  missingWorkflows: string[];
  /** How the feature runs when it does not use its workflow on this target. */
  note?: string;
}

export interface BackendStatus extends Backend {
  connected: boolean;
  error?: string;
  nodes?: number;
  apiKey: boolean;
  features: FeatureCheck[];
}

const FILE = join(DATA_DIR, "backend.json");
const CLOUD = "https://cloud.comfy.org";

function fromEnv(): Backend {
  const url = process.env.COMFY_BASE_URL?.trim();
  return url ? { target: "custom", url } : { target: "cloud" };
}

let current: Backend = fromEnv();

/** Load the saved choice at startup; without one the .env setting stands. */
export function loadBackend() {
  if (!existsSync(FILE)) return;
  try {
    apply(JSON.parse(readFileSync(FILE, "utf8")) as Backend);
  } catch {
    /* unreadable file: keep the .env setting */
  }
}

export function currentBackend(): Backend {
  return current;
}

function apply(b: Backend) {
  current = b.target === "custom" && b.url ? { target: "custom", url: b.url.replace(/\/+$/, "") } : { target: "cloud" };
  setComfyTarget(current.target === "custom" ? current.url : undefined);
  resetComfyClient();
}

export async function saveBackend(b: Backend): Promise<void> {
  apply(b);
  await writeFile(FILE, JSON.stringify(current, null, 2));
}

type ObjectInfo = Record<string, { input?: { required?: Record<string, unknown[]>; optional?: Record<string, unknown[]> } }>;

/** The target's node list. A plain ComfyUI serves /object_info; Comfy Cloud and
 *  comfy-api-proxy serve /api/object_info. */
async function objectInfo(b: Backend): Promise<ObjectInfo> {
  const key = process.env.COMFY_API_KEY?.trim();
  const base = b.target === "custom" ? b.url! : CLOUD;
  const headers: Record<string, string> = b.target === "cloud" && key ? { "X-API-Key": key } : {};
  if (b.target === "cloud" && !key) throw new Error("Comfy Cloud needs COMFY_API_KEY in app/.env");
  let last = "";
  for (const path of ["/api/object_info", "/object_info"]) {
    try {
      const res = await fetch(base + path, { headers, signal: AbortSignal.timeout(20_000) });
      if (res.ok) return (await res.json()) as ObjectInfo;
      last = `HTTP ${res.status} from ${base}${path}`;
    } catch (e) {
      last = `${base}${path}: ${(e as Error).message}`;
    }
  }
  throw new Error(`could not read the node list (${last})`);
}

type Graph = Record<string, { class_type?: string; inputs?: Record<string, unknown> }>;

/** Node classes and loader files a workflow needs that the target lacks. */
function checkGraph(graph: Graph, info: ObjectInfo) {
  const missingNodes = new Set<string>();
  const missingFiles = new Set<string>();
  const optionalFiles = new Set<string>();
  for (const node of Object.values(graph)) {
    const cls = node?.class_type;
    if (!cls) continue;
    const spec = info[cls];
    if (!spec) {
      missingNodes.add(cls);
      continue;
    }
    const inputs = { ...spec.input?.required, ...spec.input?.optional };
    for (const [name, value] of Object.entries(node.inputs ?? {})) {
      // a combo input lists the files the target has: a loader value not in it is missing there
      const options = inputs[name]?.[0];
      if (typeof value !== "string" || !Array.isArray(options) || !options.length) continue;
      if (!/\.(safetensors|ckpt|pt|pth|bin|gguf|onnx|sft)$/i.test(value)) continue;
      if (!options.includes(value)) (/lora/i.test(cls) ? optionalFiles : missingFiles).add(value);
    }
  }
  return { missingNodes: [...missingNodes].sort(), missingFiles: [...missingFiles].sort(), optionalFiles: [...optionalFiles].sort() };
}

/** Connect to `b` (or the current backend) and check every feature against it. */
export async function checkBackend(b: Backend = current): Promise<BackendStatus> {
  const base = { ...b, apiKey: !!process.env.COMFY_API_KEY?.trim() };
  let info: ObjectInfo;
  try {
    info = await objectInfo(b);
  } catch (e) {
    return { ...base, connected: false, error: (e as Error).message, features: [] };
  }
  const features: FeatureCheck[] = [];
  for (const f of FEATURES) {
    const check: FeatureCheck = { id: f.id, label: f.label, ok: true, missingNodes: [], missingFiles: [], optionalFiles: [], missingWorkflows: [] };
    for (const name of f.workflows) {
      const path = workflowPath(name);
      if (!existsSync(path)) {
        check.missingWorkflows.push(`${name}.json`);
        continue;
      }
      const { missingNodes, missingFiles, optionalFiles } = checkGraph(JSON.parse(await readFile(path, "utf8")) as Graph, info);
      check.missingNodes.push(...missingNodes.filter((n) => !check.missingNodes.includes(n)));
      check.missingFiles.push(...missingFiles.filter((n) => !check.missingFiles.includes(n)));
      check.optionalFiles.push(...optionalFiles.filter((n) => !check.optionalFiles.includes(n)));
    }
    // graphs the app builds in code: only their node classes need checking
    for (const cls of f.nodes ?? []) if (!info[cls] && !check.missingNodes.includes(cls)) check.missingNodes.push(cls);
    if (f.id === "seedance") check.note = b.target === "custom" ? "Partner nodes: your ComfyUI calls the Comfy API with your key, sent per job and never stored" : "Partner nodes on Comfy Cloud, billed to your Comfy account";
    check.ok = !check.missingNodes.length && !check.missingFiles.length && !check.missingWorkflows.length;
    // on Comfy Cloud the cards skip the Klein workflow and run FLUX 3 on the Comfy API
    if (f.id === "cast" && b.target === "cloud") Object.assign(check, { ok: base.apiKey, missingNodes: [], missingFiles: [], optionalFiles: [], note: "Runs FLUX 3 on the Comfy API (the open-weights Klein workflow needs your own ComfyUI)" });
    features.push(check);
  }
  return { ...base, connected: true, nodes: Object.keys(info).length, features };
}
