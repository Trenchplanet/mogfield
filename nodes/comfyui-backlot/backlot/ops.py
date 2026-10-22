"""Pure torch ops behind the Backlot nodes.

Everything here works on ComfyUI tensor layouts and has no ComfyUI imports, so
it can be unit tested on its own:

    IMAGE  float32 [B, H, W, C] in 0..1
    MASK   float32 [B, H, W]    in 0..1
    DEPTH  an IMAGE where bright = near (Depth Anything / MiDaS convention)
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass

import torch
import torch.nn.functional as F

# --------------------------------------------------------------------------
# helpers


def to_nchw(x: torch.Tensor) -> torch.Tensor:
    return x.permute(0, 3, 1, 2).contiguous()


def to_nhwc(x: torch.Tensor) -> torch.Tensor:
    return x.permute(0, 2, 3, 1).contiguous()


def luma(img: torch.Tensor) -> torch.Tensor:
    """[B,H,W,3] -> [B,H,W,1] Rec.709 luma."""
    w = img.new_tensor([0.2126, 0.7152, 0.0722])
    return (img[..., :3] * w).sum(-1, keepdim=True)


def depth_to_disparity(depth: torch.Tensor, like: torch.Tensor) -> torch.Tensor:
    """Normalise any depth IMAGE/MASK to [B,H,W,1] disparity in 0..1 (1 = near),
    resized and batch-matched to `like`."""
    d = depth
    if d.dim() == 3:
        d = d.unsqueeze(-1)
    d = d[..., :1]
    B, H, W = like.shape[0], like.shape[1], like.shape[2]
    if d.shape[1] != H or d.shape[2] != W:
        d = to_nhwc(F.interpolate(to_nchw(d), size=(H, W), mode="bilinear", align_corners=False))
    if d.shape[0] != B:
        idx = torch.linspace(0, d.shape[0] - 1, B).round().long()
        d = d[idx]
    lo = d.amin(dim=(1, 2, 3), keepdim=True)
    hi = d.amax(dim=(1, 2, 3), keepdim=True)
    return ((d - lo) / (hi - lo).clamp_min(1e-6)).to(like.dtype)


def pseudo_depth(like: torch.Tensor) -> torch.Tensor:
    """Fallback when no depth map is wired: a soft centre-weighted, bottom-near
    gradient. Good enough for gentle bokeh; wire a real depth model for Recast."""
    B, H, W = like.shape[:3]
    y = torch.linspace(0, 1, H, device=like.device).view(1, H, 1, 1)
    x = torch.linspace(-1, 1, W, device=like.device).view(1, 1, W, 1)
    d = 0.55 * y + 0.45 * (1 - x.abs()) * (1 - (y - 0.55).abs())
    return d.expand(B, H, W, 1).to(like.dtype)


def gaussian_blur(x: torch.Tensor, sigma: float) -> torch.Tensor:
    """Separable gaussian on NCHW."""
    if sigma <= 0.1:
        return x
    r = max(1, int(math.ceil(sigma * 3)))
    t = torch.arange(-r, r + 1, device=x.device, dtype=x.dtype)
    k = torch.exp(-(t**2) / (2 * sigma**2))
    k = k / k.sum()
    C = x.shape[1]
    kx = k.view(1, 1, 1, -1).repeat(C, 1, 1, 1)
    ky = k.view(1, 1, -1, 1).repeat(C, 1, 1, 1)
    x = F.conv2d(F.pad(x, (r, r, 0, 0), mode="replicate"), kx, groups=C)
    x = F.conv2d(F.pad(x, (0, 0, r, r), mode="replicate"), ky, groups=C)
    return x


def disc_kernel(radius: float, squeeze: float = 1.0, device=None, dtype=None) -> torch.Tensor:
    """Anti-aliased disc (or vertical ellipse when squeeze > 1, the anamorphic
    bokeh shape). Returns [k, k] summing to 1."""
    ry = radius * squeeze
    rx = radius
    R = int(math.ceil(max(rx, ry))) + 1
    t = torch.arange(-R, R + 1, device=device, dtype=dtype or torch.float32)
    yy, xx = torch.meshgrid(t, t, indexing="ij")
    dist = torch.sqrt((xx / max(rx, 1e-3)) ** 2 + (yy / max(ry, 1e-3)) ** 2)
    k = (1.0 - (dist - 1.0) * max(rx, 1.0)).clamp(0, 1)
    return k / k.sum()


def disc_blur(x: torch.Tensor, radius: float, squeeze: float = 1.0) -> torch.Tensor:
    if radius < 0.5:
        return x
    k = disc_kernel(radius, squeeze, x.device, x.dtype)
    C = x.shape[1]
    p = k.shape[-1] // 2
    w = k.view(1, 1, *k.shape).repeat(C, 1, 1, 1)
    return F.conv2d(F.pad(x, (p, p, p, p), mode="replicate"), w, groups=C)


# --------------------------------------------------------------------------
# CameraRig: preset -> per-frame camera path -> depth reprojection guide

PRESETS = [
    "static",
    "dolly_in",
    "dolly_out",
    "truck_left",
    "truck_right",
    "orbit_left",
    "orbit_right",
    "crane_up",
    "crane_down",
    "push_tilt_up",
    "handheld",
]

PRESET_PROMPTS = {
    "static": "locked-off static camera",
    "dolly_in": "slow dolly in toward the subject",
    "dolly_out": "slow dolly out, revealing the scene",
    "truck_left": "camera trucks left, parallax across the set",
    "truck_right": "camera trucks right, parallax across the set",
    "orbit_left": "camera orbits left around the subject",
    "orbit_right": "camera orbits right around the subject",
    "crane_up": "crane shot rising up",
    "crane_down": "crane shot descending",
    "push_tilt_up": "push in while tilting up",
    "handheld": "subtle handheld camera with natural sway",
}


@dataclass
class CamPose:
    tx: float = 0.0  # lateral translation (screen widths at disparity 1)
    ty: float = 0.0  # vertical translation
    tz: float = 0.0  # forward translation (dolly), + = toward scene
    yaw: float = 0.0  # pan, screen widths
    pitch: float = 0.0  # tilt, screen heights
    roll: float = 0.0  # radians
    zoom: float = 1.0  # optical zoom factor
    lock: float = 0.0  # 1 = orbit: the pivot plane stays fixed in frame


def ease(t: float, kind: str = "inout") -> float:
    if kind == "linear":
        return t
    return t * t * (3 - 2 * t)  # smoothstep


def camera_path(preset: str, frames: int, strength: float = 1.0, seed: int = 0, easing: str = "inout") -> list[CamPose]:
    if preset not in PRESETS:
        raise ValueError(f"unknown camera preset {preset!r}; expected one of {PRESETS}")
    frames = max(1, int(frames))
    s = float(strength)
    g = torch.Generator().manual_seed(int(seed))
    phases = (torch.rand(6, generator=g) * 2 * math.pi).tolist()
    out: list[CamPose] = []
    for i in range(frames):
        t = ease(i / max(1, frames - 1), easing)
        p = CamPose()
        if preset == "dolly_in":
            p.tz = 0.35 * s * t
        elif preset == "dolly_out":
            p.tz = -0.30 * s * t
        elif preset == "truck_left":
            p.tx = 0.12 * s * t
        elif preset == "truck_right":
            p.tx = -0.12 * s * t
        elif preset == "orbit_left":
            p.tx = 0.16 * s * t
            p.lock = 1.0  # counter-pan so the subject at the pivot stays put
        elif preset == "orbit_right":
            p.tx = -0.16 * s * t
            p.lock = 1.0
        elif preset == "crane_up":
            p.ty = 0.12 * s * t
            p.pitch = -0.04 * s * t
        elif preset == "crane_down":
            p.ty = -0.12 * s * t
            p.pitch = 0.04 * s * t
        elif preset == "push_tilt_up":
            p.tz = 0.2 * s * t
            p.pitch = 0.08 * s * t
        elif preset == "handheld":
            sec = i / 24.0
            p.yaw = 0.006 * s * (math.sin(2 * math.pi * 0.31 * sec + phases[0]) + 0.5 * math.sin(2 * math.pi * 0.83 * sec + phases[1]))
            p.pitch = 0.006 * s * (math.sin(2 * math.pi * 0.27 * sec + phases[2]) + 0.5 * math.sin(2 * math.pi * 0.71 * sec + phases[3]))
            p.roll = 0.004 * s * math.sin(2 * math.pi * 0.19 * sec + phases[4])
            p.tz = 0.01 * s * math.sin(2 * math.pi * 0.11 * sec + phases[5])
        out.append(p)
    return out


def path_to_json(path: list[CamPose]) -> list[dict]:
    return [asdict(p) for p in path]


def reproject(
    frames: torch.Tensor,
    disparity: torch.Tensor,
    path: list[CamPose],
    pivot: float = 0.5,
) -> tuple[torch.Tensor, torch.Tensor]:
    """2.5D depth-parallax reprojection of each frame along the camera path.

    Backward warp: for each target pixel we look up where it came from in the
    source frame, displacing by disparity (near pixels move more). `pivot` is
    the disparity that stays locked for orbits (poses with lock=1). Returns (guide IMAGE, hole MASK)
    where the mask marks pixels with no valid source (out of frame or torn at
    depth edges) - exactly the region the video model must invent.
    """
    B, H, W, _ = frames.shape
    if len(path) != B:
        idx = torch.linspace(0, len(path) - 1, B).round().long().tolist()
        path = [path[i] for i in idx]
    dev, dt = frames.device, frames.dtype
    ys = torch.linspace(-1, 1, H, device=dev, dtype=dt)
    xs = torch.linspace(-1, 1, W, device=dev, dtype=dt)
    gy, gx = torch.meshgrid(ys, xs, indexing="ij")
    aspect = W / H

    tx = torch.tensor([p.tx for p in path], device=dev, dtype=dt).view(B, 1, 1)
    ty = torch.tensor([p.ty for p in path], device=dev, dtype=dt).view(B, 1, 1)
    tz = torch.tensor([p.tz for p in path], device=dev, dtype=dt).view(B, 1, 1)
    yaw = torch.tensor([p.yaw for p in path], device=dev, dtype=dt).view(B, 1, 1)
    pitch = torch.tensor([p.pitch for p in path], device=dev, dtype=dt).view(B, 1, 1)
    roll = torch.tensor([p.roll for p in path], device=dev, dtype=dt).view(B, 1, 1)
    zoom = torch.tensor([p.zoom for p in path], device=dev, dtype=dt).view(B, 1, 1)
    lock = torch.tensor([p.lock for p in path], device=dev, dtype=dt).view(B, 1, 1)

    # roll about centre (in aspect-correct space)
    cx, cy = gx * aspect, gy
    rx = cx * torch.cos(roll) + cy * torch.sin(roll)
    ry = -cx * torch.sin(roll) + cy * torch.cos(roll)
    bx, by = rx / aspect, ry
    src_d = disparity.permute(0, 3, 1, 2)[:, :1]  # [B,1,H,W]

    def grid_for(dd: torch.Tensor) -> torch.Tensor:
        # dolly: near things scale more. s > 1 means target is magnified.
        scale = (1.0 / (1.0 - (tz * dd).clamp(max=0.85))) * zoom
        x = bx / scale
        y = by / scale
        # translation parallax: near pixels move more. A camera moving left
        # makes the scene slide right, so we sample from the left (x - shift).
        # Orbits subtract the pivot's shift (lock=1) so the subject stays put.
        x = x - 2 * tx * (dd - lock * pivot) + 2 * yaw
        y = y + 2 * ty * (dd - lock * pivot) + 2 * pitch
        return torch.stack([x, y], dim=-1)

    def sample_d(grid: torch.Tensor) -> torch.Tensor:
        return F.grid_sample(src_d, grid, mode="nearest", padding_mode="border", align_corners=True)[:, 0]

    # The warp needs the depth of the *source* pixel we land on, which we only
    # know after sampling: iterate to a fixed point from the target's own depth.
    d_used = disparity[..., 0]
    for _ in range(3):
        d_used = sample_d(grid_for(d_used))
    grid = grid_for(d_used)
    d_landed = sample_d(grid)

    guide = F.grid_sample(to_nchw(frames), grid, mode="bilinear", padding_mode="border", align_corners=True)

    x, y = grid[..., 0], grid[..., 1]
    oob = ((x.abs() > 1.0) | (y.abs() > 1.0)).to(dt)
    # where the fixed point did not settle, the pixel was hidden behind
    # something in the source: a disocclusion the model has to invent
    motion = (tx.abs() + ty.abs() + tz.abs() * 0.5).clamp_min(1e-6)
    unsettled = (((d_landed - d_used).abs() * motion * W) > 1.5).to(dt)
    hole = torch.maximum(oob, unsettled)
    hole = F.max_pool2d(hole.unsqueeze(1), 3, stride=1, padding=1)[:, 0]

    # fill holes with a soft extension of the surrounding background so the
    # guide carries no ghost copies of the subject
    keep = (1 - hole).unsqueeze(1)
    sigma = max(2.0, H / 24)
    num = gaussian_blur(guide * keep, sigma)
    den = gaussian_blur(keep, sigma)
    # far from any valid pixel the blur has nothing to go on: keep the
    # border-clamped sample there instead of fading to black
    w = (den * 10).clamp(0, 1)
    fill = w * (num / den.clamp_min(1e-4)) + (1 - w) * guide
    guide = guide * keep + fill * (1 - keep)
    return to_nhwc(guide).clamp(0, 1), hole.clamp(0, 1)


# --------------------------------------------------------------------------
# LensKit: real optics from a depth map

LENSES = {
    # name: (focal_mm, anamorphic squeeze, default T-stop)
    "18mm wide": (18, 1.0, 2.8),
    "24mm": (24, 1.0, 2.0),
    "35mm": (35, 1.0, 1.8),
    "50mm": (50, 1.0, 1.4),
    "85mm portrait": (85, 1.0, 1.4),
    "40mm anamorphic": (40, 2.0, 2.3),
    "75mm anamorphic": (75, 2.0, 2.3),
}


def focal_crop(frames: torch.Tensor, focal_mm: float, base_mm: float = 24.0) -> torch.Tensor:
    """Longer lens = tighter field of view. Centre crop by focal/base, resized
    back to the input size. Lenses wider than the base are left unchanged
    (we cannot invent field of view in a finishing pass)."""
    factor = focal_mm / base_mm
    if factor <= 1.0001:
        return frames
    B, H, W, C = frames.shape
    h, w = max(2, round(H / factor)), max(2, round(W / factor))
    y0, x0 = (H - h) // 2, (W - w) // 2
    crop = frames[:, y0 : y0 + h, x0 : x0 + w, :]
    return to_nhwc(F.interpolate(to_nchw(crop), size=(H, W), mode="bicubic", align_corners=False)).clamp(0, 1)


def depth_of_field(
    frames: torch.Tensor,
    disparity: torch.Tensor,
    focus: float,
    f_stop: float,
    focal_mm: float = 50.0,
    squeeze: float = 1.0,
    max_radius: float | None = None,
    levels: int = 6,
) -> torch.Tensor:
    """Layered depth-of-field. Circle of confusion grows with distance from the
    focus plane, with focal length squared and with 1/f-stop, like a thin lens.
    Blur happens in linear light so highlights bloom into proper bokeh discs."""
    B, H, W, C = frames.shape
    if max_radius is None:
        max_radius = H / 90.0
    k = (focal_mm / 50.0) ** 2 * (1.4 / max(f_stop, 0.7))
    coc = ((disparity - focus).abs() * k * max_radius * 2.2).clamp(0, max_radius)[..., 0]  # [B,H,W] px

    lin = to_nchw(frames[..., :3].clamp(0, 1) ** 2.2)
    # highlight boost so out-of-focus speculars read as bright discs
    lin = lin * (1 + 2.0 * (lin.amax(1, keepdim=True) - 0.85).clamp(min=0) / 0.15)

    radii = [max_radius * i / (levels - 1) for i in range(levels)]
    stack = torch.stack([disc_blur(lin, r, squeeze) for r in radii], 0)  # [L,B,3,H,W]
    pos = (coc / max(max_radius, 1e-6) * (levels - 1)).clamp(0, levels - 1 - 1e-4)
    lo = pos.floor().long()
    frac = (pos - lo).unsqueeze(1)
    lo_img = torch.gather(stack.permute(1, 2, 3, 4, 0), -1, lo.unsqueeze(1).unsqueeze(-1).expand(B, 3, H, W, 1)).squeeze(-1)
    hi_img = torch.gather(stack.permute(1, 2, 3, 4, 0), -1, (lo + 1).unsqueeze(1).unsqueeze(-1).expand(B, 3, H, W, 1)).squeeze(-1)
    out = lo_img * (1 - frac) + hi_img * frac
    out = out.clamp(0, 1) ** (1 / 2.2)
    res = to_nhwc(out)
    if C > 3:
        res = torch.cat([res, frames[..., 3:]], -1)
    return res


def halation(frames: torch.Tensor, strength: float = 0.35, threshold: float = 0.72, radius: float | None = None) -> torch.Tensor:
    """Film halation: bright edges bleed a warm red glow (light scattering back
    through the film base)."""
    if strength <= 0:
        return frames
    H = frames.shape[1]
    radius = radius or H / 60.0
    hl = ((luma(frames) - threshold) / (1 - threshold)).clamp(0, 1)
    glow = gaussian_blur(to_nchw(hl), radius)
    tint = frames.new_tensor([1.0, 0.28, 0.12]).view(1, 3, 1, 1)
    glow = to_nhwc(glow * tint) * strength
    rgb = 1 - (1 - frames[..., :3]) * (1 - glow)  # screen
    return torch.cat([rgb, frames[..., 3:]], -1).clamp(0, 1)


def anamorphic_streak(frames: torch.Tensor, strength: float = 0.25, threshold: float = 0.85) -> torch.Tensor:
    """Horizontal blue flare streaks from highlights, the anamorphic signature."""
    if strength <= 0:
        return frames
    B, H, W, _ = frames.shape
    hl = to_nchw(((luma(frames) - threshold) / (1 - threshold)).clamp(0, 1))
    streak = hl
    for r in (W / 80, W / 30, W / 12):
        r = int(max(1, r))
        streak = streak + F.avg_pool2d(F.pad(hl, (r, r, 0, 0), mode="replicate"), (1, 2 * r + 1), stride=1)
    tint = frames.new_tensor([0.35, 0.6, 1.0]).view(1, 3, 1, 1)
    add = to_nhwc(streak / 4 * tint) * strength
    return torch.cat([(frames[..., :3] + add), frames[..., 3:]], -1).clamp(0, 1)


def vignette(frames: torch.Tensor, amount: float = 0.25) -> torch.Tensor:
    if amount <= 0:
        return frames
    B, H, W, _ = frames.shape
    y = torch.linspace(-1, 1, H, device=frames.device, dtype=frames.dtype).view(1, H, 1, 1)
    x = torch.linspace(-1, 1, W, device=frames.device, dtype=frames.dtype).view(1, 1, W, 1)
    r2 = (x**2 + y**2) / 2
    v = 1 - amount * r2.clamp(0, 1) ** 1.5
    return torch.cat([frames[..., :3] * v, frames[..., 3:]], -1)


def film_grain(frames: torch.Tensor, amount: float = 0.04, size: float = 1.2, seed: int = 0) -> torch.Tensor:
    """Per-frame luminance-weighted grain (strongest in the midtones)."""
    if amount <= 0:
        return frames
    g = torch.Generator(device="cpu").manual_seed(int(seed))
    B, H, W, _ = frames.shape
    n = torch.randn((B, 1, H, W), generator=g).to(frames.device, frames.dtype)
    n = gaussian_blur(n, max(0.0, size - 0.5))
    n = n / n.std().clamp_min(1e-6)
    L = luma(frames)
    weight = 4 * L * (1 - L)  # midtone bell
    noise = to_nhwc(n) * weight * amount
    return torch.cat([(frames[..., :3] + noise), frames[..., 3:]], -1).clamp(0, 1)


def letterbox(frames: torch.Tensor, aspect: float) -> torch.Tensor:
    """Black mattes to the target aspect (no resampling)."""
    B, H, W, C = frames.shape
    out = frames.clone()
    if W / H < aspect:  # too tall: bars top/bottom
        h = round(W / aspect)
        bar = (H - h) // 2
        if bar > 0:
            out[:, :bar] = 0
            out[:, H - bar :] = 0
    else:
        w = round(H * aspect)
        bar = (W - w) // 2
        if bar > 0:
            out[:, :, :bar] = 0
            out[:, :, W - bar :] = 0
    return out


# --------------------------------------------------------------------------
# GradeLUT: .cube parsing and trilinear application


def parse_cube(text: str) -> tuple[torch.Tensor, tuple[float, float]]:
    """Parse an Adobe/Resolve .cube 3D LUT. Returns (lut [S,S,S,3] indexed
    [b,g,r], (domain_min, domain_max)). Red varies fastest in the file."""
    size = None
    dmin, dmax = 0.0, 1.0
    vals: list[list[float]] = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        key = line.split()[0].upper()
        if key == "LUT_3D_SIZE":
            size = int(line.split()[1])
        elif key == "LUT_1D_SIZE":
            raise ValueError("1D LUTs are not supported; export a 3D .cube")
        elif key == "DOMAIN_MIN":
            dmin = float(line.split()[1])
        elif key == "DOMAIN_MAX":
            dmax = float(line.split()[1])
        elif key in ("TITLE", "LUT_3D_INPUT_RANGE"):
            continue
        else:
            parts = line.split()
            if len(parts) == 3:
                vals.append([float(v) for v in parts])
    if size is None:
        raise ValueError("missing LUT_3D_SIZE")
    if len(vals) != size**3:
        raise ValueError(f"expected {size**3} entries, got {len(vals)}")
    lut = torch.tensor(vals, dtype=torch.float32).view(size, size, size, 3)
    return lut, (dmin, dmax)


def apply_lut(frames: torch.Tensor, lut: torch.Tensor, strength: float = 1.0, domain: tuple[float, float] = (0.0, 1.0)) -> torch.Tensor:
    if strength <= 0:
        return frames
    B, H, W, C = frames.shape
    vol = lut.to(frames.device, frames.dtype).permute(3, 0, 1, 2).unsqueeze(0)  # [1,3,b,g,r]
    rgb = ((frames[..., :3] - domain[0]) / (domain[1] - domain[0])).clamp(0, 1)
    grid = (rgb * 2 - 1).reshape(1, 1, B * H * W, 1, 3)  # (x=r, y=g, z=b)
    out = F.grid_sample(vol, grid, mode="bilinear", padding_mode="border", align_corners=True)  # [1,3,1,N,1]
    out = out.view(3, B, H, W).permute(1, 2, 3, 0)
    mixed = frames[..., :3] * (1 - strength) + out * strength
    return torch.cat([mixed, frames[..., 3:]], -1).clamp(0, 1)


def write_cube(path: str, fn, size: int = 33, title: str = "Backlot") -> None:
    """Write a .cube by sampling fn(rgb[N,3]) -> rgb[N,3]."""
    t = torch.linspace(0, 1, size)
    b, g, r = torch.meshgrid(t, t, t, indexing="ij")
    rgb = torch.stack([r, g, b], -1).view(-1, 3)
    out = fn(rgb).clamp(0, 1)
    with open(path, "w") as f:
        f.write(f'TITLE "{title}"\nLUT_3D_SIZE {size}\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 1 1 1\n')
        for row in out.tolist():
            f.write(f"{row[0]:.6f} {row[1]:.6f} {row[2]:.6f}\n")
