# Architecture

MOGFIELD is two programs in one package (`app/`):

- **`app/web/`**: a Vite + React single-page app. It talks only to the
  MOGFIELD server, never to Comfy, and never sees an API key.
- **`app/server/`**: a [Hono](https://hono.dev) server on Node.js. It keeps the
  library, binds your inputs to ComfyUI workflows, submits jobs through
  [`@comfyorg/sdk`](https://www.npmjs.com/package/@comfyorg/sdk), and streams
  progress back over server-sent events.

```
browser ──HTTP/SSE──▶ MOGFIELD server ──@comfyorg/sdk──▶ Comfy Cloud / Comfy API
                         │                         └──▶ your own ComfyUI (LOCAL)
                         └── app/data/  (uploads, renders, depth maps, history)
```

## Where a job runs

`server/backend.ts` decides the target: **Comfy Cloud** (API mode, needs
`COMFY_API_KEY`) or **your own ComfyUI** (LOCAL mode, `COMFY_BASE_URL` or the
URL entered in the app). The choice is saved in `app/data/backend.json` and
applied live. For each feature it reads the target's `object_info` and reports
which nodes or model files are missing.

Partner models (Seedance, Kling, Veo, MiniMax…) are billed to your Comfy
account in both modes; in LOCAL mode the server sends the key with each job and
never stores it on your ComfyUI.

## Two ways to call a model

1. **As a ComfyUI workflow.** Graphs in [`workflows/`](../workflows/) (or built
   in code, like `providers/seedanceWorkflow.ts` and `frames.ts`) are bound by
   node **title** (`BL:video`, `BL:prompt`, …) and run on the current target.
   Every take saves the graph it ran next to the video, and **Open in ComfyUI**
   (`workflowExport.ts`) downloads the graph your current settings would run.
2. **Through the Comfy model router.** `providers/comfyRouter.ts` sends a
   request straight to a partner model. `providers/catalog.ts` reads the whole
   Comfy API catalog: each model's published OpenAPI schema names its input and
   output media, so the Create pages can list every video and image model.
   `providers/schemaFill.ts` fills any model's request (prompt, pictures,
   resolution, length, aspect) by field name and type, and reports what it
   cannot fill instead of sending a bad request. Schemas are cached in
   `app/data/catalog-v2.json` by etag.

## Server modules

| Module | What it does |
| --- | --- |
| `index.ts` | Routes, the job queue, the library and server-sent progress |
| `backend.ts` | API / LOCAL target and per-feature checks |
| `config.ts` | Settings from `app/.env` and data folders |
| `pipeline.ts` | Character Swap / Restyle / Re-shoot: depth, motion, sheet, prompt, provider |
| `seedance.ts` | Prompt packs for Seedance, with the second-by-second motion lock |
| `motion.ts` | Measures camera and subject motion in a take |
| `depth.ts` | Depth maps (GPU workflow, or CPU via onnxruntime) |
| `genjustsu.ts`, `preparationStore.ts` | Preparation: SAM 3 masks, vocals, review |
| `frames.ts`, `t2v.ts` | Create (text, start / end frame, references) and Extend |
| `characters.ts`, `sheet.ts` | Create Character, reference sheets, style descriptions |
| `agent.ts` | Agent mode: director, storyboard, key frames, shots |
| `workflowExport.ts` | Open in ComfyUI |
| `media.ts`, `links.ts` | ffmpeg helpers; pasted TikTok / Instagram / X links |
| `providers/` | One file per way of generating video; listed in `providers/index.ts` |
| `engines/` | `comfy` (workflows on a ComfyUI) and `preview` (ffmpeg only) |

## Adding a model

- A model in the Comfy API catalog needs no code: it appears in Create when
  its schema can be filled. If it needs an unusual field, teach
  `schemaFill.ts` the field name.
- A model with its own workflow: add the API-format graph to `workflows/`,
  title its input and output nodes, and add a provider in `providers/`
  (implement `types.ts`, list it in `index.ts`).

## Data

Everything you make lives in `app/data/` (and preparation artifacts in
`app/.private-data/`). Both are gitignored. Delete them to start fresh.
