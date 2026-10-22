// Show what Comfy recorded for one model request, e.g. why Seedance rejected it.
// Read-only: it looks the request up, it does not submit anything.
//   node scripts/comfy-why.mjs <comfy-request-id> [provider/model]
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
try {
  process.loadEnvFile(join(here, "..", ".env"));
} catch {
  /* COMFY_API_KEY may already be in the environment */
}
const { comfy } = await import("@comfyorg/sdk");

const [id, model = "byteplus/dreamina-seedance-2-5-260628"] = process.argv.slice(2);
if (!id) {
  console.error("usage: node scripts/comfy-why.mjs <comfy-request-id> [provider/model]");
  process.exit(1);
}

// signed upload links are long and private; hide them
const redact = (v) => JSON.parse(JSON.stringify(v ?? null, (_k, x) => (typeof x === "string" && /^https?:\/\//.test(x) ? "<url>" : x)));

const handle = comfy.models.handle(model, id);
const status = await handle.status();
console.log(`status: ${status.status}   error_type: ${status.errorType ?? "-"}`);
console.log(JSON.stringify(redact(status.raw), null, 2));
try {
  await handle.get();
  console.log("result: succeeded");
} catch (e) {
  console.log("result error:", JSON.stringify(redact({ name: e?.name, message: e?.message, errorType: e?.errorType, httpStatus: e?.httpStatus, detail: e?.detail }), null, 2));
}
