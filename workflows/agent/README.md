# Agent rebuilds

These are API-format rebuilds of the root-level workflows, made with comfy-mcp
on 2026-10-30. Each graph keeps the same nodes, ids, wiring, settings and `BL:` titles
as the matching file in `../`. The script asserts this before it writes a file. Inputs are listed
in the order the live ComfyUI schema uses (`object_info`, core `v0.43.0-18-gb5a43215`).

| File | Closest template | `validate_workflow` (local, no custom nodes, no models) |
| --- | --- | --- |
| `backlot_cast.json` | `image_flux3_klein_distilled_t2i` | 3 errors: model files not installed |
| `backlot_depth.json` | `utility_depth_anything3_image_depth_estimation` | 1 error: `DepthAnythingV2Preprocessor` (comfyui_controlnet_aux) not installed |
| `backlot_direct.json` | `utility_depth_anything3_image_depth_estimation` | 5 errors: controlnet_aux + `comfyui-backlot` nodes not installed |
| `backlot_genjustsu.json` | `utility-audioseparation` | 2 errors: `DepthAnythingV2Preprocessor`, `AudioSeparation` not installed |
| `backlot_genjustsu_sam.json` | `utility_video_segment_sam3` | 4 errors: SAM 3 custom-node classes not installed |
| `backlot_h3_swap.json` | `video_minimax_h3_r2v` | 6 errors: model files not installed |
| `backlot_recast.json` | `video_ltx2_3_ic_lora` | 13 errors: LTXVideo IC-LoRA nodes, controlnet_aux, `comfyui-backlot`, model files |
| `mogfield_seedance_reshoot.json` | `api_seedance2_0_r2v` | valid (partner node, spends credits) |
| `mogfield_seedance_restyle.json` | `api_seedance2_0_r2v` | valid (partner node, spends credits) |
| `mogfield_seedance_t2v.json` | `api_seedance2_5_r2v` | valid (partner node, spends credits) |

Every input on an installed core node was checked against the live schema for names, enums, ranges,
dynamic-combo keys and output slots. No problems were found. The H3 `length` of 124 fits the 17n+5 grid,
and 480×864 are multiples of 32. The `Backlot*` inputs were checked against
`nodes/comfyui-backlot/backlot/nodes.py`. Nodes from third-party packs that aren't
installed (`DepthAnythingV2Preprocessor`, `AudioSeparation`, `LoadSAM3Model`/`SAM3*`,
`LTXICLoRALoaderModelOnly`, `LTXAddVideoICLoRAGuide*`) are kept exactly as they were and still need a live
check. None of these graphs has been run.

`editor/` holds the same 10 graphs in ComfyUI's editor format, with every wire drawn. Nodes are laid out
left to right in coloured groups (Inputs → Depth & camera → Models → Prompt → Conditioning & latents →
Sampling → Decode → Look → Output). Each graph has an "About this workflow" note.
They were built with `comfy workflow add-node`/`set-widget`/`connect`. Each one is also saved in the local
ComfyUI sidebar under `mogfield-agent/`. The node ids match the API files. The build checks that every
wire and title matches. Nodes from packs that aren't installed are kept as red placeholders that still
hold their wires and widget values. This applies to the model filenames too, since the CLI won't
set a file that isn't installed. Use the API files in this folder for the Backlot server.

`editor/backlot_all.json` combines all 10 graphs as lanes in one workflow, driven by the **Backlot Menu**
node from `comfyui-backlot`. Node ids are `lane × 100 + original id`. Only the lane picked in the menu is
unmuted, so a run sends just that lane. Validating the file with each lane active in turn gives the same
results as the matching standalone file. `BL:` titles repeat across lanes, so the Backlot server should
keep using the per-workflow API files.

`editor/pika_h3_flex_{t2v,fl2va,ref2va}.json` are ComfyUI's Pika H3 Flex templates, unchanged
(fetched 2026-10-31), for opening in the editor. The API graphs the server runs are
`../backlot_pika_h3_*.json` (see [`../README.md`](../README.md#pika-h3-flex-local-only)).

`local/minimax_h3_character_swap_pro4500_v1.json` is an editor graph that the server does not
load, so it was not rebuilt.
