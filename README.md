# MOGFIELD

**One phone take in. A recast, restyled, re-shot video out.**

MOGFIELD is an open-source AI film studio built on the Comfy platform. Every
generation runs as a ComfyUI workflow, either on **Comfy Cloud** ("API" mode) or
on **your own ComfyUI** ("LOCAL" mode), through [`@comfyorg/sdk`](https://www.npmjs.com/package/@comfyorg/sdk).
The workflows are plain JSON files in [`workflows/`](workflows/), so you can open,
inspect and change exactly what runs.

It is a Vite + React web app with a small Hono server. The browser never talks
to ComfyUI and never sees your key: the server binds your take and settings to
the workflow, submits it, and streams progress back.

## Screenshots

<!-- Add screenshots or a GIF of the app here, e.g. docs/screenshot-create.png -->

_Coming soon._

## Features

- **Create**: add a video and your characters, press Generate. MOGFIELD builds a
  depth map, measures camera and subject motion per second, lays out a character
  reference sheet, writes the prompt (with a second-by-second motion lock) and
  sends it to the model you pick. No prompt writing needed. **Pro** mode exposes
  every control.
- **Character Studio**: make reusable characters from a photo and a few
  elements, with reference sheets and character cards.
- **Restyle**: keep the take's motion (via its depth map) with new characters,
  world and style.
- **Re-shoot**: the same take filmed again from another angle (profile, drone, ...).
- **Text to video**: a reference image and a prompt, in any common aspect ratio.
- **Preparation and review** (adapted from Genjustsu): before spending video
  credits, the take is normalized, gets coloured depth and SAM 3 person masks,
  and its vocals are separated and pitch-shifted. You review the mask overlay and
  approve it, then render a cheap draft before the full-resolution final.
- **MiniMax H3 character swap** on your own ComfyUI or Comfy Cloud.
- **Depth maps** on the GPU (Depth Anything V2 Large) or on the CPU with no setup
  (Depth Anything V2 Small via onnxruntime).
- **Direct**: real camera paths reprojected through the take's depth map, real
  lens optics (focal crop, thin-lens bokeh, anamorphic), LUT grading and
  letterboxing, from the bundled `comfyui-backlot` node pack.
- **Library, queue and gallery**: every take keeps the exact workflow it ran
  (`Workflow` button), a 16:9 A/B export, and a vertical before/after for sharing.
- **Paste a link**: TikTok, Instagram and X video links become input takes (via `yt-dlp`).
- **Preview engine**: with no Comfy configured, an ffmpeg pass approximates
  camera, lens and grade so the whole UI is usable without a GPU or account.

## Requirements

- Node.js 22 or newer
- ffmpeg and ffprobe on `PATH`
- Optional: Python 3 with `opencv-python` and `numpy` (preparation helper),
  [Rubber Band](https://breakfastquay.com/rubberband/) (`brew install rubberband`)
  for the vocal pitch shift, and `yt-dlp` for pasted links
- For API mode: a Comfy account and API key
- For LOCAL mode: a ComfyUI install with the custom nodes listed below

## Setup

```bash
cd app
npm install
cp .env.example .env     # then put your key in COMFY_API_KEY=
npm run build
npm start                # http://localhost:8787
```

For development with hot reload, run `npm run dev` instead and open
http://localhost:5173 (the API stays on 8787).

The server listens on `BACKLOT_PORT` (default `8787`). All settings are in
[`app/.env.example`](app/.env.example) with comments.

## API vs LOCAL

Use the **API / LOCAL** switch in the top bar. The choice is saved in
`app/data/backend.json` and can change while the server runs. The backend sheet
connects to the target, reads its node list and shows, per feature, which node
classes or model files are missing.

### API (Comfy Cloud)

Set `COMFY_API_KEY` in `app/.env`. Workflows run on Comfy Cloud and partner
models (Seedance, FLUX 3, MiniMax) are billed to your Comfy account. Nothing to
install.

### LOCAL (your own ComfyUI)

Set `COMFY_BASE_URL` (for example `http://127.0.0.1:8189`) or enter the URL in
the app. A plain ComfyUI, [`comfy-api-proxy`](https://pypi.org/project/comfy-api-proxy/)
or a cloud GPU pod URL all work. Partner nodes such as Seedance still call the
Comfy API from your ComfyUI; the server sends your key with each job and never
stores it there.

What each feature needs on your ComfyUI (from `FEATURES` in
[`app/server/backend.ts`](app/server/backend.ts)):

| Feature | Workflow(s) | Custom nodes and models |
| --- | --- | --- |
| Seedance: Restyle, Re-shoot, Text to video, Create | built in code (`app/server/providers/seedanceWorkflow.ts`) | Core ComfyUI with the Comfy API partner nodes (`ByteDance2ReferenceNodeV2`, `ByteDance2TextToVideoNode`) and a Comfy API key |
| Depth maps | `backlot_depth.json` | [comfyui_controlnet_aux](https://github.com/Fannovel16/comfyui_controlnet_aux) (`DepthAnythingV2Preprocessor`) |
| Preparation (depth, vocals, SAM 3) | `backlot_genjustsu.json`, `backlot_genjustsu_sam.json` | comfyui_controlnet_aux; a ComfyUI build with `AudioSeparation` and the SAM 3 video nodes (`LoadSAM3Model`, `SAM3VideoSegmentation`, `SAM3Propagate`, `SAM3VideoOutput`) and `models/sam3/sam3.pt` |
| H3 character swap | `backlot_h3_swap.json` | `MiniMaxH3ReferenceToVideo` / `MiniMaxH3SigmaShift` and the MiniMax H3 weights named in the graph (UNet, Qwen3-VL text encoder, video and audio VAEs, optional LoRAs) |
| Character cards (FLUX 3) | `backlot_cast.json` | FLUX 3 Image Klein weights; on Comfy Cloud this runs FLUX 3 on the Comfy API instead |
| Direct (camera, lens, grade) | `backlot_direct.json` | This repo's [`nodes/comfyui-backlot`](nodes/comfyui-backlot) (symlink into `ComfyUI/custom_nodes`) and comfyui_controlnet_aux |
| LTX 2.5 Recast (open weights) | `backlot_recast.json` | `comfyui-backlot`, comfyui_controlnet_aux, [ComfyUI-LTXVideo](https://github.com/Lightricks/ComfyUI-LTXVideo) and the LTX 2.5 weights |

Missing LoRAs are reported as optional: the app can run without them.

## Workflows

[`workflows/`](workflows/) holds API-format ComfyUI graphs. The server finds
nodes by **title** (`BL:video`, `BL:prompt`, `BL:seed`, `BL:output`, ...), not by
id, so you can re-export a graph from ComfyUI without touching server code.
`workflows/local/` holds editor-format graphs to open in ComfyUI by hand. See
[`workflows/README.md`](workflows/README.md) for every graph, its status and the
title tags.

## Your API key

Your Comfy API key lives only in `app/.env`, which is gitignored. The server
reads it at startup and sends it only to Comfy (Comfy Cloud, or your own
ComfyUI for partner nodes) with your own jobs. It is never sent to the browser,
written to logs, or stored in saved workflows.

## Repository layout

| Path | What |
| --- | --- |
| `app/server/` | Hono server: jobs, pipeline, Comfy engines and model providers |
| `app/web/` | React app |
| `app/scripts/` | Read-only helpers: list your Comfy Seedance models (`comfy-models.mjs`), explain a failed request (`comfy-why.mjs`) |
| `workflows/` | ComfyUI workflows the server runs |
| `nodes/comfyui-backlot/` | ComfyUI node pack: CameraRig, LensKit, GradeLUT, Letterbox, ShotCard |
| `examples/` | Sample clips the app preloads |
| `deploy/` | Running the workflows on a Comfy API deployment |

## Keyboard

| Key | |
| --- | --- |
| Space | play / pause |
| `[` `]` | previous / next lens |
| G | generate |
| D | depth map on / off |
| F | flip to "How it works" |
| Esc | back |

## Development

```bash
cd app
npm run typecheck
npm test
npm run build
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT, see [LICENSE](LICENSE). The `nodes/comfyui-backlot` node pack carries its
own license file. Third-party work is credited in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Model weights are not bundled;
each model has its own license.
