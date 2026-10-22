# comfyui-backlot

Real camera paths and real optics for ComfyUI video workflows. Part of
[Backlot](../../README.md); usable on its own in any graph.

| Node | Does |
| --- | --- |
| **Backlot CameraRig** | Turns a preset (dolly, truck, orbit, crane, push-tilt, handheld) into a per-frame camera path and reprojects the take through its depth map. Outputs a `guide` video, a `holes` mask of disoccluded pixels, the reprojected `depth`, the path as JSON and a short `camera_prompt`. Feed `guide` + `holes` to an LTX IC-LoRA / union-control pass so the move is geometry, not a prompt suffix. |
| **Backlot LensKit** | Focal-length crop, thin-lens depth of field (disc bokeh, oval bokeh on anamorphics) driven by depth, optional rack focus, halation, anamorphic streaks, vignette, film grain. |
| **Backlot GradeLUT** | Applies any 3D `.cube` LUT (trilinear). Seven looks ship in `luts/`; drop your own in. |
| **Backlot Letterbox** | 2.39 / 1.85 / 16:9 / 9:16 mattes. |
| **Backlot ShotCard** | A slate / title card frame for reels. |

Depth convention: bright = near (Depth Anything V2, MiDaS). Without a depth
input the nodes fall back to a soft pseudo-depth.

## Install

```bash
cd ComfyUI/custom_nodes
git clone <this repo> backlot && ln -s backlot/nodes/comfyui-backlot comfyui-backlot
```

No extra Python dependencies beyond what ComfyUI ships (torch, numpy, Pillow).

## Tests

```bash
uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python torch numpy pillow pytest
.venv/bin/python -m pytest -q
```

Rebuild the stock LUTs with `python -m backlot.looks`.
