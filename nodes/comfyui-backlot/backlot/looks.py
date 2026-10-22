"""The stock Backlot looks, defined as colour functions and baked to .cube.

The same .cube files are loaded by the ComfyUI GradeLUT node and by the
browser's WebGL preview, so what you see live is what renders.

    python -m backlot.looks   # regenerates luts/*.cube
"""

from __future__ import annotations

import os

import torch

from .ops import write_cube


def _luma(rgb):
    return (rgb * rgb.new_tensor([0.2126, 0.7152, 0.0722])).sum(-1, keepdim=True)


def _sat(rgb, s):
    L = _luma(rgb)
    return L + (rgb - L) * s


def _contrast(rgb, c, pivot=0.45):
    return (rgb - pivot) * c + pivot


def _scurve(x, k=1.0):
    # filmic s-curve, k > 0 adds contrast
    return x + k * 0.12 * torch.sin(2 * torch.pi * (x - 0.5)) * -1


def _split_tone(rgb, shadow, highlight, amt=1.0):
    L = _luma(rgb)
    sh = rgb.new_tensor(shadow) * (1 - L) ** 2
    hi = rgb.new_tensor(highlight) * L**2
    return rgb + amt * (sh + hi)


def tungsten_night(rgb):
    x = _scurve(rgb, 1.0)
    x = _split_tone(x, [-0.03, 0.02, 0.07], [0.07, 0.02, -0.06])
    return _sat(x, 1.08)


def bleach_bypass(rgb):
    L = _luma(rgb)
    x = rgb * 0.5 + (L * 0.5)
    x = _contrast(x, 1.35)
    return _sat(x, 0.55)


def noir(rgb):
    L = _luma(rgb)
    x = _contrast(L.expand_as(rgb), 1.5, 0.42)
    x = _scurve(x, 1.2)
    return x + x.new_tensor([0.0, 0.0, 0.012])


def western(rgb):
    x = _sat(rgb, 0.7)
    x = _split_tone(x, [0.03, 0.0, -0.04], [0.09, 0.04, -0.07])
    x = _scurve(x, 0.6)
    return x * x.new_tensor([1.04, 0.98, 0.86])


def scifi_cyan(rgb):
    x = _split_tone(rgb, [-0.04, 0.03, 0.08], [-0.02, 0.05, 0.06])
    x = _scurve(x, 0.9)
    x = x * x.new_tensor([0.9, 1.02, 1.08])
    return _sat(x, 0.9)


def nature_doc(rgb):
    x = _sat(rgb, 1.22)
    x = _scurve(x, 0.5)
    return x * x.new_tensor([1.0, 1.03, 0.98])


def anime_pastel(rgb):
    x = _contrast(rgb, 0.85, 0.5) + 0.04
    x = _sat(x, 1.25)
    return _split_tone(x, [0.02, 0.0, 0.06], [0.03, 0.02, 0.0])


LOOKS = {
    "tungsten_night": tungsten_night,
    "bleach_bypass": bleach_bypass,
    "noir": noir,
    "western": western,
    "scifi_cyan": scifi_cyan,
    "nature_doc": nature_doc,
    "anime_pastel": anime_pastel,
}


def bake_all(out_dir: str, size: int = 33) -> list[str]:
    os.makedirs(out_dir, exist_ok=True)
    paths = []
    for name, fn in LOOKS.items():
        p = os.path.join(out_dir, f"{name}.cube")
        write_cube(p, fn, size, title=f"Backlot {name}")
        paths.append(p)
    return paths


if __name__ == "__main__":
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    for p in bake_all(os.path.join(here, "luts")):
        print("wrote", p)
