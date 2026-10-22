import json
import os
import sys

import pytest
import torch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backlot import ops  # noqa: E402
from backlot.looks import LOOKS  # noqa: E402
from backlot.nodes import NODE_CLASS_MAPPINGS, LUT_DIR  # noqa: E402


def frames(B=4, H=48, W=64):
    g = torch.Generator().manual_seed(0)
    return torch.rand(B, H, W, 3, generator=g)


def ramp_depth(B=4, H=48, W=64):
    # near at bottom, far at top
    return torch.linspace(0, 1, H).view(1, H, 1, 1).expand(B, H, W, 3).clone()


# ---------- camera


@pytest.mark.parametrize("preset", ops.PRESETS)
def test_camera_path_starts_at_rest(preset):
    path = ops.camera_path(preset, 25)
    assert len(path) == 25
    p0 = path[0]
    if preset != "handheld":
        assert p0.tx == p0.ty == p0.tz == p0.yaw == p0.pitch == 0


def test_unknown_preset_raises():
    with pytest.raises(ValueError):
        ops.camera_path("barrel_roll", 10)


def test_static_reprojection_is_identity():
    x = frames()
    d = ops.depth_to_disparity(ramp_depth(), x)
    guide, holes = ops.reproject(x, d, ops.camera_path("static", 4))
    assert torch.allclose(guide, x, atol=1e-4)
    assert holes.max() == 0


def test_dolly_in_magnifies_near_more_than_far():
    B, H, W = 2, 64, 64
    x = torch.zeros(B, H, W, 3)
    # vertical stripes so magnification is measurable along x
    x[..., 0] = (torch.arange(W) % 8 < 4).float().view(1, 1, W)
    d = ops.depth_to_disparity(ramp_depth(B, H, W), x)
    path = [ops.CamPose(), ops.CamPose(tz=0.5)]
    guide, _ = ops.reproject(x, d, path)
    near_row, far_row = guide[1, H - 2, :, 0], guide[1, 1, :, 0]
    # count stripe transitions: fewer transitions = more magnification
    trans = lambda r: ((r[1:] > 0.5) != (r[:-1] > 0.5)).sum().item()  # noqa: E731
    assert trans(near_row) < trans(far_row)


def test_truck_creates_holes_at_frame_edge():
    x = frames(2)
    d = ops.depth_to_disparity(ramp_depth(2), x)
    path = [ops.CamPose(), ops.CamPose(tx=0.3)]
    _, holes = ops.reproject(x, d, path, pivot=0.0)
    assert holes[0].max() == 0
    assert holes[1].mean() > 0.01


def test_camera_rig_node_outputs():
    node = NODE_CLASS_MAPPINGS["BacklotCameraRig"]()
    guide, holes, path_json, prompt, depth = node.run(frames(), "orbit_left", 1.0, 0.5, 0, depth=ramp_depth())
    assert depth.shape == (4, 48, 64, 3)
    assert guide.shape == (4, 48, 64, 3)
    assert holes.shape == (4, 48, 64)
    assert len(json.loads(path_json)) == 4
    assert "orbit" in prompt


# ---------- lens


def test_focal_crop_keeps_size_and_zooms():
    x = frames(1, 40, 40)
    y = ops.focal_crop(x, 48, 24)
    assert y.shape == x.shape
    assert not torch.allclose(x, y)
    assert torch.equal(ops.focal_crop(x, 18, 24), x)


def test_dof_keeps_focus_plane_sharp_and_blurs_rest():
    B, H, W = 1, 64, 64
    x = (torch.rand(B, H, W, 3, generator=torch.Generator().manual_seed(1)) > 0.5).float()
    d = ops.depth_to_disparity(ramp_depth(B, H, W), x)
    y = ops.depth_of_field(x, d, focus=1.0, f_stop=1.4, focal_mm=85, max_radius=4)
    sharp_err = (y[:, -1:] - x[:, -1:]).abs().mean()
    blur_err = (y[:, :3] - x[:, :3]).abs().mean()
    assert sharp_err < 0.05
    assert blur_err > 0.15


def test_smaller_fstop_blurs_more():
    x = (torch.rand(1, 64, 64, 3, generator=torch.Generator().manual_seed(2)) > 0.5).float()
    d = ops.depth_to_disparity(ramp_depth(1, 64, 64), x)
    wide = ops.depth_of_field(x, d, 1.0, 1.4, 50, max_radius=5)
    stopped = ops.depth_of_field(x, d, 1.0, 8.0, 50, max_radius=5)
    assert (wide - x).abs().mean() > (stopped - x).abs().mean()


def test_lens_kit_node_runs_all_lenses():
    node = NODE_CLASS_MAPPINGS["BacklotLensKit"]()
    for lens in ops.LENSES:
        (y,) = node.run(frames(3), lens, 2.0, 0.6, 0.3, 0.03, 0.2, 0, depth=ramp_depth(3), focus_end=0.2)
        assert y.shape == (3, 48, 64, 3)
        assert y.min() >= 0 and y.max() <= 1


def test_grain_varies_per_frame():
    x = torch.full((2, 32, 32, 3), 0.5)
    y = ops.film_grain(x, 0.1, seed=3)
    assert not torch.allclose(y[0], y[1])


def test_letterbox_239():
    x = torch.ones(1, 1080, 1920, 3)
    y = ops.letterbox(x, 2.39)
    assert y[0, 0].sum() == 0 and y[0, 540].sum() > 0


# ---------- LUT


def test_identity_cube_roundtrip(tmp_path):
    p = tmp_path / "id.cube"
    ops.write_cube(str(p), lambda rgb: rgb, size=17)
    lut, dom = ops.parse_cube(p.read_text())
    x = frames()
    y = ops.apply_lut(x, lut, 1.0, dom)
    assert torch.allclose(x, y, atol=2e-3)


def test_lut_axis_order_red_fastest(tmp_path):
    # LUT that swaps red and blue: catches a transposed axis immediately
    p = tmp_path / "swap.cube"
    ops.write_cube(str(p), lambda rgb: rgb[:, [2, 1, 0]], size=9)
    lut, dom = ops.parse_cube(p.read_text())
    x = torch.tensor([[[[0.9, 0.2, 0.1]]]])
    y = ops.apply_lut(x, lut, 1.0, dom)
    assert torch.allclose(y, torch.tensor([[[[0.1, 0.2, 0.9]]]]), atol=1e-3)


def test_parse_cube_errors():
    with pytest.raises(ValueError):
        ops.parse_cube("LUT_3D_SIZE 2\n0 0 0\n")
    with pytest.raises(ValueError):
        ops.parse_cube("LUT_1D_SIZE 2\n")


def test_shipped_luts_load_and_apply():
    files = [f for f in os.listdir(LUT_DIR) if f.endswith(".cube")]
    assert len(files) == len(LOOKS)
    node = NODE_CLASS_MAPPINGS["BacklotGradeLUT"]()
    for f in files:
        (y,) = node.run(frames(1), f, 0.8)
        assert y.shape == (1, 48, 64, 3)


def test_noir_is_monochrome():
    node = NODE_CLASS_MAPPINGS["BacklotGradeLUT"]()
    (y,) = node.run(frames(1), "noir.cube", 1.0)
    assert (y[..., 0] - y[..., 1]).abs().max() < 0.02


# ---------- shot card


def test_shot_card():
    node = NODE_CLASS_MAPPINGS["BacklotShotCard"]()
    (img,) = node.run(270, 480, "Backlot", "1A", "3", "40mm", "#OpenSourceHiggsfield", 5)
    assert img.shape == (5, 480, 270, 3)
    assert img.std() > 0.05


def test_orbit_keeps_pivot_plane_fixed_and_moves_background():
    B, H, W = 2, 32, 64
    x = torch.rand(B, H, W, 3, generator=torch.Generator().manual_seed(4))
    d = torch.zeros(B, H, W, 1)
    d[:, :, 24:40] = 1.0  # a near subject band, background far
    path = [ops.CamPose(), ops.CamPose(tx=0.1, lock=1.0)]
    guide, _ = ops.reproject(x, d, path, pivot=1.0)
    assert torch.allclose(guide[1, :, 28:36], x[1, :, 28:36], atol=1e-4)  # subject locked
    assert not torch.allclose(guide[1, :, 2:10], x[1, :, 2:10], atol=1e-2)  # background slides


def test_truck_left_slides_scene_right():
    B, H, W = 2, 8, 64
    x = torch.zeros(B, H, W, 3)
    x[:, :, 30:34] = 1.0
    d = torch.ones(B, H, W, 1)
    guide, _ = ops.reproject(x, d, [ops.CamPose(), ops.CamPose(tx=0.05)])
    col = guide[1, 4, :, 0].argmax().item()
    assert col > 33


def test_letterbox_node_native_is_untouched():
    node = NODE_CLASS_MAPPINGS["BacklotLetterbox"]()
    x = frames(1)
    (y,) = node.run(x, "native")
    assert torch.equal(x, y)
