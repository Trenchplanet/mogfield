# Workflows

Root-level JSON files are API-format ComfyUI graphs the Backlot server runs
through the Comfy SDK. The server finds nodes by **title**, not id, so you can
re-export a graph from ComfyUI without touching server code. `local/` holds
ComfyUI editor workflows; the server does not load those graphs. `agent/` holds
schema-checked rebuilds of every graph here, laid-out editor versions, and
`agent/editor/backlot_all.json`: all graphs in one workflow driven by the
**Backlot Menu** node (see [`agent/README.md`](agent/README.md)).

| File | Status | What it does |
| --- | --- | --- |
| `backlot_pika_h3_t2v.json` | LOCAL only; schema-checked, not run | Prompt → **Pika H3 Flex** (MiniMax H3 FL2VA + Pika LoRA) → video with sound |
| `backlot_pika_h3_fl2va.json` | LOCAL only; schema-checked, not run | Start frame (+ optional end frame) → **Pika H3 Flex** → video with sound. Create, Extend and the director's shots |
| `backlot_pika_h3_ref2va.json` | LOCAL only; schema-checked, not run | Up to 9 reference pictures → **Pika H3 Flex** (MiniMax H3 Ref2VA + Pika LoRA) → video with sound. Create with references, and the Studio with a character sheet |
| `backlot_direct.json` | ships | Take → Depth Anything V2 → **CameraRig** (depth-reprojected camera move) → **LensKit** → **GradeLUT** → **Letterbox** → MP4 |
| `backlot_depth.json` | drafted, untested — needs GPU run | Take → Depth Anything V2 → depth MP4 for the monitor's depth view (bright = near) |
| `backlot_recast.json` | drafted, untested — needs GPU run | Take → Depth Anything V2 → **CameraRig** → LTX 2.5 distilled v2v (union-control IC-LoRA on the moved depth, ingredients IC-LoRA on the `BL:cast` sheet) → **LensKit** → **GradeLUT** → **Letterbox** → MP4 |
| `backlot_cast.json` | drafted, untested — needs GPU run | FLUX 3 Image Klein text-to-image for cast and set reference cards |
| `backlot_genjustsu.json` | schema-checked against Comfy Cloud; execution not run | Depth Anything V2 and Comfy audio separation |
| `backlot_genjustsu_sam.json` | schema-checked against Comfy Cloud; execution not run | SAM 3 tracking on the colorized depth video |
| `mogfield_seedance_t2v.json` | example; the server builds this graph per job | Reference image → **Seedance 2.5** (ByteDance2ReferenceNodeV2) → MP4: Text to video |
| `mogfield_seedance_restyle.json` | example; built per job | Take's depth map + character picture → **Seedance 2.0** → MP4: Restyle |
| `mogfield_seedance_reshoot.json` | example; built per job | The take → **Seedance 2.0** → MP4: Re-shoot from another angle |

The Seedance graphs are built in code (`app/server/providers/seedanceWorkflow.ts`)
because the number of reference inputs changes per job. Every take saves the
exact graph it ran as `<take>.workflow.json` (the **Workflow** button on a take).
The same graph runs on Comfy Cloud (API) and on your own ComfyUI (LOCAL); on
your own ComfyUI the partner node is paid with your Comfy API key, which the
server sends with the job and never stores. Set `MOGFIELD_SEEDANCE_VIA=router`
to send Seedance through the Comfy model router instead.

## Pika H3 Flex (LOCAL only)

The three `backlot_pika_h3_*.json` graphs come from ComfyUI's own templates
(`video_pika_h3_flex_t2v`, `_fl2va`, `_ref2va`), converted to API format with
comfy-cli's converter. The template's subgraph, resolution selector and
frame-count math were flattened out so the server sets `width`, `height` and
`length` on the node titled `BL:h3` itself (`app/server/pika.ts`). The sampler
settings were kept: LCM, 6 manual sigmas, LoRA strength 1.0. Comfy Cloud and
the Comfy API do not serve Pika H3 Flex, so it runs only when **Where it runs**
is set to LOCAL (your own ComfyUI, e.g. a GPU pod). It needs no Comfy API key.
With LOCAL on, Pika H3 Flex is the default in Create, Extend and the Studio.
With API on, it is shown as unavailable and the other models stay the default.
The director can pick `pika-h3`, but its default remains Seedance. Pika always
makes sound, so the Studio keeps the model's audio.

| Title | Node | Set by the server |
| --- | --- | --- |
| `BL:h3` | MiniMaxH3ImageToVideo / MiniMaxH3ReferenceToVideo | `prompt`, `width`, `height`, `length` (17n+5 frames at 24 fps, 5–15 s) |
| `BL:seed` | RandomNoise | `noise_seed` |
| `BL:start-frame`, `BL:end-frame` | LoadImage (fl2va) | `image`; the end frame is removed when there isn't one |
| `BL:cast`, `BL:cast-2`… | LoadImage (ref2va) | `image`; one node per reference picture, up to 9 |
| `BL:lora`, `BL:unet` | LoraLoaderModelOnly, UNETLoader | not set (the Pika LoRA and the H3 base) |
| `BL:output` | SaveVideo | the output the server downloads |

The target needs these files. They are listed in the templates' notes, and the
H3 base files are shared with the other H3 graphs:

```
models/vae/minimax_h3_video_vae_int8_convrot.safetensors        2.6 GB
models/vae/minimax_h3_audio_vae_fp32.safetensors                0.6 GB
models/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors 14.6 GB
models/diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors   19.5 GB  (t2v, fl2va)
models/diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors  19.5 GB  (ref2va)
models/loras/pika_h3_flex_fl2va_v1_bf16.safetensors                         (t2v, fl2va)
models/loras/pika_h3_flex_ref2va_v1_bf16.safetensors                        (ref2va)
```

They come from [Comfy-Org/MiniMax-H3](https://huggingface.co/Comfy-Org/MiniMax-H3) on Hugging Face.
Pika's own release is at [Pika-Labs/Pika-H3-Flex](https://huggingface.co/Pika-Labs/Pika-H3-Flex).
The adapter runs on the MiniMax H3 base weights, so the H3 licence terms below
apply too. Check Pika's licence for the adapter itself before commercial use.
Every class validates against a live ComfyUI (core v0.43.0). The only errors
left are the model files above, which are not installed on the Mac this was
built on. None of the graphs has been run yet.

## Local MiniMax H3 character swap

[`local/minimax_h3_character_swap_pro4500_v1.json`](local/minimax_h3_character_swap_pro4500_v1.json)
is a ComfyUI editor graph adapted from
[Alissonerdx's H3 character-swap workflow](https://huggingface.co/Alissonerdx/Minimax-H3-ComfyUI/blob/main/workflows/minimax_h3_character_swap_workflow.json).
It replaces the upstream guide-latent adapter with the requested
[`h3_character_swap_pro4500_1000.safetensors` V1 LoRA](https://huggingface.co/akatz-ai/MiniMax-H3-Character-Swap-LoRA/blob/main/h3_character_swap_pro4500_1000.safetensors),
at strength 1.0, and clears the upstream example media paths. The model card
labels V1 as a previous release and recommends V1.5 for new work; this graph
uses V1 because that is the requested checkpoint.

To use it, install the LoRA in `ComfyUI/models/loras/`, install the H3 base
model and the other weights selected by the graph, then open the JSON in a
compatible local ComfyUI. Add your source clip and character reference in the
BFS Shot Planner. Preserve the `H3 (17n+5)` frame grid. The graph also uses
custom nodes from KJNodes, BFSNodes, Fearnworks Nodes, RMBG, SolAttn, and
VideoHelperSuite; missing node classes must be installed in that ComfyUI.
It is not an API-format graph and is not loaded by the Backlot server.

The adapter retains the
[MiniMax H3 Community License Agreement](https://huggingface.co/akatz-ai/MiniMax-H3-Character-Swap-LoRA/blob/main/LICENSE).
Its licensed territory excludes the EU, UK, South Korea, and the United States;
obtain separate authorization before using it in an excluded territory. The
workflow contains an in-graph modification and license notice as well.

## Title tags

| Title | Node | Fields the server sets |
| --- | --- | --- |
| `BL:video` | LoadVideo | `file` (uploaded via SDK assets) |
| `BL:cast` | LoadImage | `image` |
| `BL:prompt` | any text encode | `text` |
| `BL:seed` | sampler / noise | `seed`, `noise_seed` |
| `BL:camera` | BacklotCameraRig | `preset`, `strength`, `seed` |
| `BL:lens` | BacklotLensKit | `lens`, `f_stop`, `focus`, `focus_end`, `halation`, `grain`, `seed` |
| `BL:grade` | BacklotGradeLUT | `lut`, `strength` |
| `BL:letterbox` | BacklotLetterbox | `aspect` |
| `BL:output` | SaveVideo / SaveImage | the output the server downloads |

Only fields that exist on the node, and are widget values rather than links,
get set, so a template's wiring is never overwritten.

## Building `backlot_recast.json`

1. In ComfyUI, open the LTX 2.5 IC-LoRA / union-control example workflow from
   the Lightricks ComfyUI wrapper.
2. Replace its video loader with `LoadVideo` titled `BL:video`, feed the frames
   through `DepthAnythingV2Preprocessor` and a pose preprocessor as control.
3. Insert `BacklotCameraRig` before the LTX guide input: wire its `guide`
   output as the control video and `holes` as the inpaint mask, so the model
   fills the disocclusions the move opens up. Its `camera_prompt` output can be
   concatenated into the prompt.
4. Add a `LoadImage` titled `BL:cast` for the FLUX Klein reference, and title the
   positive prompt node `BL:prompt` and the sampler `BL:seed`.
5. After decode, chain `BacklotLensKit` (`BL:lens`, reuse the depth map),
   `BacklotGradeLUT` (`BL:grade`), `BacklotLetterbox` (`BL:letterbox`),
   `CreateVideo`, `SaveVideo` (`BL:output`).
6. Settings → enable Dev mode, then Workflow → Export (API), save here as
   `backlot_recast.json`.
7. Before submitting, check for partner/API nodes:
   `grep -iE '"class_type": *"[^"]*(Api|Partner|Router)' workflows/*.json`
   must print nothing.

## Draft status (2026-10-17)

`backlot_recast.json` and `backlot_cast.json` were written by hand in API format,
without a GPU, and have **not run yet**. Every `class_type`, input name and
output slot was checked against the source of ComfyUI `fc04da9` (2026-10-16),
Lightricks ComfyUI-LTXVideo `44c8a36` (2026-10-14), comfyui_controlnet_aux and
this repo's node pack. A link and input-name check passes on all three graphs.
Nothing has been checked against a live `/object_info`.

What the recast graph takes from Lightricks `example_workflows/2.5/LTX-2.5_ICLoRA_Union_Control_Distilled.json`
(flattened from its subgraphs):

- `UNETLoader` → `LTXICLoRALoaderModelOnly`, `CLIPLoader` (type `ltxv`), the two
  `VAELoader`s, `LTXVConditioning`, `EmptyLTXVLatentVideo`, `LTXVEmptyLatentAudio`,
  `LTXVConcatAVLatent`, `RandomNoise` / `CFGGuider` / `KSamplerSelect` /
  `ManualSigmas` (the 8 distilled sigmas) / `SamplerCustomAdvanced`,
  `LTXVSeparateAVLatent`, `LTXVCropGuides`, `VAEDecodeTiled`, and the model
  filenames.
- Stage 1 only. The example's ×2 latent-upscale stage 2 is left out to keep
  VRAM down, so output is about 544 px on the short side.

What I decided myself, untested, and most likely to need changing on the first run:

- **Control signal.** `BacklotCameraRig.depth` (depth seen from the *moved*
  camera) is the union-control guide, not the reprojected RGB `guide`. Union
  control expects a depth, canny or pose map, and the same output feeds LensKit.
  The pose preprocessor is dropped: union control takes one annotator per guide.
- **Holes.** `LTXAddVideoICLoRAGuide` has no mask input, so `holes` is inverted
  and fed to `LTXAddVideoICLoRAGuideAdvanced.attention_mask`. The guide is then
  ignored inside the disocclusions and the model fills them. This uses
  per-region guide attention, not the inpaint IC-LoRA (which would be a third
  LoRA).
- **Cast.** `BL:cast` is held on every frame (`RepeatImageBatch`) and injected
  through a second guide with the **ingredients** IC-LoRA stacked on the union
  one. Lightricks ships these two LoRAs only in separate workflows, so the
  combination is unproven. Fallback: delete nodes 12, 22, 23 and 24, then rewire
  `27.model` → `11`, `27`/`32` conditioning → `21`, and `25.video_latent` → `21.2`.
- **Length.** The take is trimmed to 121 frames (8n+1, 5 s at 24 fps, 4 s at 30 fps).
- **Audio.** The generated audio latent is sampled but not decoded. The take's
  own audio goes into `CreateVideo`.
- **Prompt.** `BL:prompt` is a plain `CLIPTextEncode`, so the server can bind
  `text`. CameraRig's `camera_prompt` is not concatenated, because a linked
  `text` would stop the server binding it.
- **Gemma API node removed.** The example's `GemmaAPITextEncode` (LTX API key)
  and the local `TextGenerateLTX2Prompt` enhancer are both gone. The first is a
  partner/API node; the second loads another LLM.
- **Weights.** Uses the example's filenames: the bf16 22B transformer and the
  conv video VAE (the lower-memory option the example lists). I haven't
  verified any INT8/NVFP4 LTX 2.5 file names. On a 24 GB card, swap
  `unet_name` for a quantized file once you've confirmed what exists.
- **The server needs a cast card.** `BL:cast` defaults to `cast.png`. If a recast
  is submitted without one, `LoadImage` fails validation.

`backlot_cast.json` comes from Comfy-Org `templates/image_flux3_klein_distilled_t2i.json`
(flattened): `UNETLoader` `flux3_image_klein_sd_int8_convrot`, `CLIPLoader`
`qwen3vl_4b_int8_convrot` (type `flux3`), `flux2-vae`, `EmptyFlux2LatentImage`
1024², `KSampler` with 16 steps, euler/simple, cfg 1. The template's Qwen 3.5 9B
prompt upsampler (`TextGenerate`) is left out.

The two `backlot_genjustsu*.json` workflows split the original order into Comfy
depth/audio separation, local depth colorization, then Comfy SAM 3 tracking on
that colored depth video. They export a depth video, binary mask video, and
vocal stem for local mask review and the +3-semitone Rubber Band pass. Their node
names and fields were checked against the configured Comfy Cloud
`/api/object_info` endpoint. Neither workflow was **submitted**; confirm Comfy
Cloud workflow access, model availability, and any applicable usage before the
first preparation run.

`backlot_direct.json`: every node name checks out against the sources above. The
only change is to `SaveVideo`, where `format` is now a dynamic combo with
`format.codec`. Both `format.codec` and the old flat `codec` are now sent, so
current and older builds should both accept it.

The node names in `backlot_direct.json` (`LoadVideo`, `GetVideoComponents`,
`CreateVideo`, `SaveVideo` from core; `DepthAnythingV2Preprocessor` from
comfyui_controlnet_aux) should be checked against your ComfyUI build on the
first run: if one was renamed, load the graph in ComfyUI, fix it, and
re-export.
