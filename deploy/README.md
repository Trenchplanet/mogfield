# Deploy: Comfy API

The hosted try link runs the same workflows on a Comfy API deployment
(needs a Comfy Cloud Standard plan or above).

```bash
# 1. In your local ComfyUI with everything installed and working:
#    Manager → Snapshot → Save, copy the snapshot JSON here as deploy/snapshot.json
comfy build init --from-snapshot deploy/snapshot.json
comfy build push
comfy deploy up
```

The snapshot must include `comfyui-backlot` (this repo's node pack),
`comfyui_controlnet_aux` (Depth Anything V2) and Lightricks
`ComfyUI-LTXVideo` (IC-LoRA nodes), and no partner/API node packs.

Models the workflows reference (exact filenames):

| Folder | File | Used by |
| --- | --- | --- |
| `diffusion_models` | `ltx-2.5-22b-distilled-transformer-bf16.safetensors` | recast |
| `loras` | `ltx-2.3-22b-ic-lora-union-control-ref0.5.safetensors` | recast |
| `loras` | `ltx-2.3-22b-ic-lora-ingredients-0.9.safetensors` | recast |
| `vae` | `ltx-2.5-video-vae-conv-bf16.safetensors`, `ltx-2.5-audio-vae-bf16.safetensors` | recast |
| `text_encoders` | `gemma4-12b-with-proj-ltx-2.5-bf16.safetensors` | recast |
| `diffusion_models` | `flux3_image_klein_sd_int8_convrot.safetensors` | cast |
| `text_encoders` | `qwen3vl_4b_int8_convrot.safetensors` | cast |
| `vae` | `flux2-vae.safetensors` | cast |
| controlnet_aux ckpts | `depth_anything_v2_vitl.pth` | direct, recast |

Then point the app at it:

```bash
export COMFY_BASE_URL="https://<deployment>.run.comfy.app"
export COMFY_API_KEY="comfyui-..."
export BACKLOT_RENDER_CAP=5        # renders per visitor per day
npm run build && npm start
```
