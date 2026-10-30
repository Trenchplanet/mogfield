"""ComfyUI node classes for comfyui-backlot."""

from __future__ import annotations

import json
import os

import numpy as np
import torch
from PIL import Image, ImageDraw, ImageFont

from . import ops

LUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "luts")
CATEGORY = "Backlot"


def _lut_files() -> list[str]:
    try:
        return sorted(f for f in os.listdir(LUT_DIR) if f.lower().endswith(".cube"))
    except FileNotFoundError:
        return []


class BacklotCameraRig:
    """Turns a camera preset into a real per-frame camera path, then reprojects
    the source take through its depth map. The output guide video and hole mask
    are the control signal for LTX (union control / IC-LoRA inpaint), so the
    move is driven by geometry rather than a prompt suffix."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "preset": (ops.PRESETS, {"default": "dolly_in"}),
                "strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 3.0, "step": 0.05}),
                "pivot": ("FLOAT", {"default": 0.5, "min": 0.0, "max": 1.0, "step": 0.01, "tooltip": "Disparity that stays locked during orbits (0 = far, 1 = near)."}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 2**31 - 1}),
            },
            "optional": {
                "depth": ("IMAGE", {"tooltip": "Per-frame depth, bright = near (Depth Anything V2)."}),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK", "STRING", "STRING", "IMAGE")
    RETURN_NAMES = ("guide", "holes", "camera_path_json", "camera_prompt", "depth")
    FUNCTION = "run"
    CATEGORY = CATEGORY

    def run(self, images, preset, strength, pivot, seed, depth=None):
        disp = ops.depth_to_disparity(depth, images) if depth is not None else ops.pseudo_depth(images)
        path = ops.camera_path(preset, images.shape[0], strength, seed)
        guide, holes = ops.reproject(images, disp, path, pivot)
        # depth seen from the moved camera, so LensKit focuses on the new framing
        moved_depth, _ = ops.reproject(disp.expand(*disp.shape[:3], 3), disp, path, pivot)
        return (guide, holes, json.dumps(ops.path_to_json(path)), ops.PRESET_PROMPTS[preset], moved_depth)


class BacklotLensKit:
    """Real optics from a depth map: focal-length crop, thin-lens depth of
    field with disc (or anamorphic oval) bokeh, halation, anamorphic streaks,
    vignette and grain."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "lens": (list(ops.LENSES.keys()), {"default": "50mm"}),
                "f_stop": ("FLOAT", {"default": 1.8, "min": 0.7, "max": 22.0, "step": 0.1}),
                "focus": ("FLOAT", {"default": 0.7, "min": 0.0, "max": 1.0, "step": 0.01, "tooltip": "Focus plane as disparity (1 = nearest)."}),
                "halation": ("FLOAT", {"default": 0.3, "min": 0.0, "max": 1.5, "step": 0.05}),
                "grain": ("FLOAT", {"default": 0.035, "min": 0.0, "max": 0.3, "step": 0.005}),
                "vignette": ("FLOAT", {"default": 0.2, "min": 0.0, "max": 1.0, "step": 0.05}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 2**31 - 1}),
            },
            "optional": {
                "depth": ("IMAGE",),
                "focus_end": ("FLOAT", {"default": -1.0, "min": -1.0, "max": 1.0, "step": 0.01, "tooltip": "If >= 0, rack focus from `focus` to this over the clip."}),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("images",)
    FUNCTION = "run"
    CATEGORY = CATEGORY

    def run(self, images, lens, f_stop, focus, halation, grain, vignette, seed, depth=None, focus_end=-1.0):
        focal, squeeze, _ = ops.LENSES[lens]
        disp = ops.depth_to_disparity(depth, images) if depth is not None else ops.pseudo_depth(images)
        x = ops.focal_crop(images, focal)
        disp = ops.focal_crop(disp.expand(*disp.shape[:3], 3), focal)[..., :1]
        out = []
        B = x.shape[0]
        # process in chunks to bound memory; per-chunk focus for rack focus
        chunk = 8
        for i in range(0, B, chunk):
            sl = slice(i, min(B, i + chunk))
            f = focus
            if focus_end is not None and focus_end >= 0 and B > 1:
                f = focus + (focus_end - focus) * (i / (B - 1))
            y = ops.depth_of_field(x[sl], disp[sl], f, f_stop, focal, squeeze)
            out.append(y)
        x = torch.cat(out, 0)
        x = ops.halation(x, halation)
        if squeeze > 1:
            x = ops.anamorphic_streak(x, 0.25)
        x = ops.vignette(x, vignette)
        x = ops.film_grain(x, grain, seed=seed)
        return (x,)


class BacklotGradeLUT:
    """Applies a .cube 3D LUT with trilinear interpolation. Drop your own
    .cube files into comfyui-backlot/luts."""

    @classmethod
    def INPUT_TYPES(cls):
        files = _lut_files() or ["none"]
        return {
            "required": {
                "images": ("IMAGE",),
                "lut": (files, {"default": files[0]}),
                "strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01}),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("images",)
    FUNCTION = "run"
    CATEGORY = CATEGORY
    _cache: dict = {}

    def run(self, images, lut, strength):
        if lut == "none":
            return (images,)
        path = os.path.join(LUT_DIR, os.path.basename(lut))
        key = (path, os.path.getmtime(path))
        if key not in self._cache:
            with open(path) as f:
                self._cache[key] = ops.parse_cube(f.read())
        table, domain = self._cache[key]
        return (ops.apply_lut(images, table, strength, domain),)


class BacklotLetterbox:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"images": ("IMAGE",), "aspect": (["native", "2.39", "1.85", "1.78", "0.5625"], {"default": "native"})}}

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "run"
    CATEGORY = CATEGORY

    def run(self, images, aspect):
        if aspect == "native":  # keep the input's own shape
            return (images,)
        return (ops.letterbox(images, float(aspect)),)


def _font(size: int, mono: bool = False):
    candidates = (
        ["DejaVuSansMono-Bold.ttf", "Menlo.ttc", "Courier New Bold.ttf"]
        if mono
        else ["DejaVuSansCondensed-Bold.ttf", "Arial Narrow Bold.ttf", "HelveticaNeue.ttc", "DejaVuSans-Bold.ttf"]
    )
    for c in candidates:
        try:
            return ImageFont.truetype(c, size)
        except OSError:
            continue
    return ImageFont.load_default(size=size)


def render_shot_card(width: int, height: int, title: str, scene: str, take: str, lens: str, footer: str) -> Image.Image:
    img = Image.new("RGB", (width, height), (11, 11, 12))
    d = ImageDraw.Draw(img)
    u = min(width, height) / 100
    amber = (255, 176, 64)
    # clapper sticks
    stripe_h = int(9 * u)
    y0 = int(height * 0.18)
    for i in range(-2, int(width / (8 * u)) + 3):
        x = i * 8 * u
        col = (240, 240, 236) if i % 2 == 0 else (20, 20, 22)
        d.polygon([(x, y0), (x + 8 * u, y0), (x + 4 * u, y0 + stripe_h), (x - 4 * u, y0 + stripe_h)], fill=col)
    d.text((width / 2, height * 0.42), title.upper(), font=_font(int(11 * u)), fill=(244, 240, 232), anchor="mm")
    rows = [("SCENE", scene), ("TAKE", take), ("LENS", lens)]
    for i, (k, v) in enumerate(rows):
        y = height * (0.56 + i * 0.075)
        d.text((width * 0.18, y), k, font=_font(int(3.6 * u), True), fill=(130, 128, 122), anchor="lm")
        d.text((width * 0.82, y), v, font=_font(int(4.4 * u), True), fill=amber, anchor="rm")
    d.text((width / 2, height * 0.9), footer, font=_font(int(3.4 * u), True), fill=(200, 196, 188), anchor="mm")
    return img


class BacklotShotCard:
    """A slate / title card frame for reels: title, scene, take, lens, footer."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "width": ("INT", {"default": 1080, "min": 64, "max": 4096}),
                "height": ("INT", {"default": 1920, "min": 64, "max": 4096}),
                "title": ("STRING", {"default": "BACKLOT"}),
                "scene": ("STRING", {"default": "1A"}),
                "take": ("STRING", {"default": "1"}),
                "lens": ("STRING", {"default": "40mm anamorphic"}),
                "footer": ("STRING", {"default": "#OpenSourceHiggsfield"}),
                "frames": ("INT", {"default": 24, "min": 1, "max": 240}),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "run"
    CATEGORY = CATEGORY

    def run(self, width, height, title, scene, take, lens, footer, frames):
        img = render_shot_card(width, height, title, scene, take, lens, footer)
        t = torch.from_numpy(np.asarray(img).astype(np.float32) / 255.0).unsqueeze(0)
        return (t.repeat(frames, 1, 1, 1),)


class BacklotMenu:
    """The Backlot menu panel (web/backlot_menu.js). It picks which lane of the combined
    workflow runs; the frontend never sends it to the server, so it does no work here."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES = ()
    FUNCTION = "run"
    CATEGORY = CATEGORY

    def run(self):
        return ()


NODE_CLASS_MAPPINGS = {
    "BacklotCameraRig": BacklotCameraRig,
    "BacklotLensKit": BacklotLensKit,
    "BacklotGradeLUT": BacklotGradeLUT,
    "BacklotLetterbox": BacklotLetterbox,
    "BacklotShotCard": BacklotShotCard,
    "BacklotMenu": BacklotMenu,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "BacklotCameraRig": "Backlot CameraRig",
    "BacklotLensKit": "Backlot LensKit",
    "BacklotGradeLUT": "Backlot GradeLUT",
    "BacklotLetterbox": "Backlot Letterbox",
    "BacklotShotCard": "Backlot ShotCard",
    "BacklotMenu": "Backlot Menu",
}
