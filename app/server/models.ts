// Where every model file the workflows load comes from on Hugging Face, and a
// one-go download script for your own ComfyUI (Where it runs > Download models).
// Links are the ones ComfyUI's own templates list (Oct 2026), or the model's own
// repo where no template lists it. A file with no link is named in the script
// so you can find it yourself.

import type { BackendStatus } from "./backend.js";

const H3 = "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main";

export interface ModelFile {
  /** folder under ComfyUI/models */
  dir: string;
  url?: string;
  /** a gated repo: accept its licence on Hugging Face and set HF_TOKEN */
  gated?: boolean;
  note?: string;
}

export const MODEL_FILES: Record<string, ModelFile> = {
  // MiniMax H3 base: Pika H3 Flex and H3 character swap
  "minimax_h3_video_vae_int8_convrot.safetensors": { dir: "vae", url: `${H3}/vae/minimax_h3_video_vae_int8_convrot.safetensors` },
  "minimax_h3_video_vae_fp16.safetensors": { dir: "vae", url: `${H3}/vae/minimax_h3_video_vae_fp16.safetensors` },
  "minimax_h3_audio_vae_fp32.safetensors": { dir: "vae", url: `${H3}/vae/minimax_h3_audio_vae_fp32.safetensors` },
  "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors": { dir: "text_encoders", url: `${H3}/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` },
  "minimax_h3_fl2va_pruned_int8_convrot.safetensors": { dir: "diffusion_models", url: `${H3}/diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors` },
  "minimax_h3_ref2va_pruned_int8_convrot.safetensors": { dir: "diffusion_models", url: `${H3}/diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors` },
  // Pika H3 Flex adapters
  "pika_h3_flex_fl2va_v1_bf16.safetensors": { dir: "loras", url: `${H3}/loras/pika_h3_flex_fl2va_v1_bf16.safetensors` },
  "pika_h3_flex_ref2va_v1_bf16.safetensors": { dir: "loras", url: `${H3}/loras/pika_h3_flex_ref2va_v1_bf16.safetensors` },
  // H3 character swap
  "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors": { dir: "loras", url: "https://huggingface.co/lightx2v/Minimax-h3-Turbo/resolve/main/minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors" },
  "h3_character_swap_v1.5.safetensors": { dir: "loras", url: "https://huggingface.co/akatz-ai/MiniMax-H3-Character-Swap-LoRA/resolve/main/h3_character_swap_v1.5.safetensors", note: "MiniMax H3 Community License: excludes the EU, UK, US and South Korea" },
  "h3_character_swap_pro4500_1000.safetensors": { dir: "loras", url: "https://huggingface.co/akatz-ai/MiniMax-H3-Character-Swap-LoRA/resolve/main/h3_character_swap_pro4500_1000.safetensors", note: "MiniMax H3 Community License: excludes the EU, UK, US and South Korea" },
  // Genjutsu prep: SAM 3 (Depth Anything V2 downloads itself on first use)
  "sam3.pt": { dir: "sam3", url: "https://huggingface.co/facebook/sam3/resolve/main/sam3.pt", gated: true },
  // Character cards (FLUX 3 Klein)
  "flux2-vae.safetensors": { dir: "vae", url: "https://huggingface.co/black-forest-labs/flux-3-image-klein-comfy/resolve/main/vae/flux2-vae.safetensors" },
  "qwen3vl_4b_int8_convrot.safetensors": { dir: "text_encoders", url: "https://huggingface.co/black-forest-labs/flux-3-image-klein-comfy/resolve/main/text_encoders/qwen3vl_4b_int8_convrot.safetensors" },
  "flux3_image_klein_sd_int8_convrot.safetensors": { dir: "diffusion_models", note: "not on Hugging Face under this name; the template now uses flux3-image-klein-int8-convrot.safetensors" },
  // LTX 2.5 Recast (hand-drafted graph)
  "ltx-2.5-audio-vae-bf16.safetensors": { dir: "vae", url: "https://huggingface.co/Lightricks/LTX-2.5/resolve/main/vae/ltx-2.5-audio-vae-bf16.safetensors" },
  "ltx-2.3-22b-ic-lora-union-control-ref0.5.safetensors": { dir: "loras", url: "https://huggingface.co/Lightricks/LTX-2.3-22b-IC-LoRA-Union-Control/resolve/main/ltx-2.3-22b-ic-lora-union-control-ref0.5.safetensors" },
  "ltx-2.5-22b-distilled-transformer-bf16.safetensors": { dir: "diffusion_models", note: "not on Hugging Face under this name (Lightricks/LTX-2.5 lists an int8 file)" },
  "ltx-2.5-video-vae-conv-bf16.safetensors": { dir: "vae", note: "not on Hugging Face under this name (Lightricks/LTX-2.5 lists ltx-2.5-video-vae-bf16)" },
  "gemma4-12b-with-proj-ltx-2.5-bf16.safetensors": { dir: "text_encoders", note: "not on Hugging Face under this name (Lightricks/LTX-2.5 lists an int8 file)" },
  "ltx-2.3-22b-ic-lora-ingredients-0.9.safetensors": { dir: "loras", note: "not found on Hugging Face" },
};

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** A bash script that fetches the files the target is missing (all of them when it could not be checked), feature by feature. */
export function downloadScript(status: BackendStatus, only?: string[]): string {
  const features = status.features.filter((f) => !only?.length || only.includes(f.id));
  const lines = [
    "#!/usr/bin/env bash",
    `# MOGFIELD models for ${status.target === "custom" ? status.url : "Comfy Cloud"}, made ${new Date().toISOString().slice(0, 16)}Z.`,
    "# Run it in your ComfyUI folder (the one with models/), or pass that folder: bash mogfield-models.sh /workspace/ComfyUI",
    "# Gated files (SAM 3) need you to accept the licence on Hugging Face first, then: export HF_TOKEN=hf_...",
    "# Already downloaded files are skipped and a broken download resumes, so it is safe to run again.",
    "set -eu",
    'cd "${1:-.}"',
    '[ -d models ] || { echo "No models/ folder here: run this inside your ComfyUI folder, or pass its path."; exit 1; }',
    "fetch() { # out url",
    '  if [ -n "${HF_TOKEN:-}" ]; then curl -fL --retry 3 -C - -H "Authorization: Bearer $HF_TOKEN" -o "$1" "$2"; else curl -fL --retry 3 -C - -o "$1" "$2"; fi',
    "}",
    "get() { # folder file url",
    '  mkdir -p "models/$1"',
    '  if [ -s "models/$1/$2" ]; then echo "✓ $2"; return; fi',
    '  echo "↓ $2"',
    '  if fetch "models/$1/$2.part" "$3"; then mv "models/$1/$2.part" "models/$1/$2"; else echo "✕ $2 failed (a gated file needs HF_TOKEN; run again to resume)"; fi',
    "}",
  ];
  const done = new Set<string>();
  const manual: string[] = [];
  for (const f of features) {
    const files = [...f.missingFiles, ...f.optionalFiles].filter((x) => !done.has(x));
    if (!files.length && !f.missingNodes.length) continue;
    lines.push("", `# ${f.label}`);
    // node packs are not models: install them in ComfyUI (Manager, or comfy node install)
    if (f.missingNodes.length) lines.push(`echo ${q(`! ${f.label} also needs node classes this ComfyUI lacks (install their node pack): ${f.missingNodes.join(", ")}`)}`);
    for (const file of files) {
      done.add(file);
      const name = file.split("/").pop()!;
      const m = MODEL_FILES[name];
      if (m?.url) lines.push(`get ${q(m.dir)} ${q(name)} ${q(m.url)}${m.gated ? "  # gated: needs HF_TOKEN" : ""}${m.note ? `  # ${m.note}` : ""}`);
      else manual.push(`#   ${m?.dir ?? "?"}/${name}${m?.note ? `: ${m.note}` : ": no known download link"}`);
    }
  }
  if (!done.size) lines.push("", "echo 'Nothing to download: this ComfyUI has every model file the app uses.'");
  if (manual.length) lines.push("", "# Not downloadable from here, get these yourself:", ...manual, `echo ${q(`${manual.length} file(s) need a manual download: see the end of this script.`)}`);
  lines.push("", "echo 'Done. Restart ComfyUI (or refresh its model list), then press Check in MOGFIELD.'", "");
  return lines.join("\n");
}
