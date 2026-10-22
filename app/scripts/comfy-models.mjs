// Read-only: list the Seedance / Dreamina models Comfy offers this account and
// print one model's input rules (types, allowed values, limits, descriptions).
//   node scripts/comfy-models.mjs [provider/model]
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
try {
  process.loadEnvFile(join(here, "..", ".env"));
} catch {
  /* COMFY_API_KEY may already be in the environment */
}
const { comfy } = await import("@comfyorg/sdk");

const used = process.env.MOGFIELD_SEEDANCE_MODEL?.trim() || "byteplus/dreamina-seedance-2-5-260628";
const target = process.argv[2] ?? used;
console.log(`app sends Seedance 2.5 requests to: ${used}${process.env.MOGFIELD_SEEDANCE_MODEL ? " (pinned by MOGFIELD_SEEDANCE_MODEL)" : " (default)"}\n`);

const short = (v) => (typeof v === "string" && v.length > 220 ? v.slice(0, 220) + "…" : v);
console.log("Seedance / Dreamina models in your Comfy catalog:");
for await (const m of comfy.models.list()) {
  if (!/seedance|dreamina/i.test(m.id)) continue;
  const extra = Object.fromEntries(Object.entries(m).filter(([k, v]) => !["id", "provider", "model"].includes(k) && v != null && typeof v !== "object").map(([k, v]) => [k, short(v)]));
  console.log(`  ${m.id === target ? "→" : " "} ${m.id}${Object.keys(extra).length ? "  " + JSON.stringify(extra) : ""}`);
}

const { document: doc } = await comfy.models.schema(target);
const ref = (s, d = 0) => {
  if (!s || d > 10) return s;
  if (s.$ref) return ref(doc.components?.schemas?.[s.$ref.split("/").pop()], d + 1);
  if (s.allOf) return { type: "object", properties: Object.assign({}, ...s.allOf.map((p) => ref(p, d + 1)?.properties ?? {})), required: s.allOf.flatMap((p) => ref(p, d + 1)?.required ?? []) };
  const alt = s.anyOf ?? s.oneOf;
  if (alt && !s.type) return { ...ref(alt.find((a) => ref(a, d + 1)?.type !== "null") ?? alt[0], d + 1), description: s.description ?? ref(alt[0], d + 1)?.description };
  return s;
};
const rule = (s) => {
  const r = [];
  if (s.type) r.push(s.type);
  if (s.enum) r.push(`one of ${JSON.stringify(s.enum)}`);
  for (const k of ["minimum", "maximum", "minItems", "maxItems", "minLength", "maxLength", "default", "format"]) if (s[k] !== undefined) r.push(`${k}=${JSON.stringify(s[k])}`);
  return r.join(" · ");
};
const walk = (s, path, depth, required = []) => {
  s = ref(s);
  if (!s || depth > 4) return;
  for (const [name, raw] of Object.entries(s.properties ?? {})) {
    const p = ref(raw);
    const full = path ? `${path}.${name}` : name;
    console.log(`  ${full}${required.includes(name) ? " (required)" : ""}: ${rule(p)}`);
    if (p.description) console.log(`      ${p.description.replace(/\s+/g, " ")}`);
    if (p.type === "object") walk(p, full, depth + 1, p.required ?? []);
    if (p.type === "array" && p.items) walk(p.items, `${full}[]`, depth + 1, ref(p.items)?.required ?? []);
  }
};
console.log(`\nInput rules for ${target}:`);
for (const [route, ops] of Object.entries(doc.paths ?? {})) {
  const op = ops.post;
  if (!op) continue;
  if (op.summary || op.description) console.log(`  [${route}] ${String(op.summary ?? "")} ${String(op.description ?? "").replace(/\s+/g, " ")}`);
  const body = ref(op.requestBody?.content?.["application/json"]?.schema);
  if (body) walk(body, "", 0, body.required ?? []);
}
