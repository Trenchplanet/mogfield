"""Small OpenCV media helpers for the Genjustsu-style preparation flow.
Upstream workflow reference: sirioberati/Genjustsu-Open-Source-Workflow (MIT).
"""
import json
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np


def to_h264(path):
    """Re-encode an OpenCV mp4v (MPEG-4 Part 2) file to H.264 in place, frame for frame.

    Seedance only accepts H.264/H.265 reference videos (an mp4v depth video is
    rejected as invalid input), and browsers will not play mp4v either.
    """
    src = Path(path)
    tmp = src.with_name(src.stem + ".h264" + src.suffix)
    subprocess.run([
        "ffmpeg", "-y", "-v", "error", "-i", str(src),
        "-vf", "setpts=N/(24*TB),scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p", "-r", "24",
        "-an", "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-movflags", "+faststart", str(tmp),
    ], check=True)
    tmp.replace(src)


def colorize(src, dst):
    cap = cv2.VideoCapture(str(src))
    if not cap.isOpened():
        raise RuntimeError("could not open depth video")
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = cap.get(cv2.CAP_PROP_FPS) or 24.0
    out = cv2.VideoWriter(str(dst), cv2.VideoWriter_fourcc(*"mp4v"), fps, (width, height))
    count = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        out.write(cv2.applyColorMap(gray, cv2.COLORMAP_INFERNO))
        count += 1
    cap.release()
    out.release()
    if not count:
        raise RuntimeError("empty depth video")
    to_h264(dst)


def extract_masks(video_path, destination):
    dst = Path(destination)
    dst.mkdir(parents=True, exist_ok=True)
    for old in dst.glob("mask_*.png"):
        old.unlink()
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise RuntimeError("could not open Comfy SAM mask video")
    count = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if count >= 1800:
            cap.release()
            raise RuntimeError("SAM returned an unreasonable frame count")
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        _, binary = cv2.threshold(gray, 127, 255, cv2.THRESH_BINARY)
        if not cv2.imwrite(str(dst / ("mask_%06d.png" % count)), binary):
            cap.release()
            raise RuntimeError("could not save SAM mask frame %d" % count)
        count += 1
    cap.release()
    if not count:
        raise RuntimeError("SAM returned no masks")
    return count


def composite(original, depth, masks, composite_path, overlay_path, mask_video_path, report_path):
    source = cv2.VideoCapture(str(original))
    depth_cap = cv2.VideoCapture(str(depth))
    if not source.isOpened() or not depth_cap.isOpened():
        raise RuntimeError("could not open source or depth video")
    width = int(source.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(source.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = source.get(cv2.CAP_PROP_FPS) or 24.0
    source_count = int(source.get(cv2.CAP_PROP_FRAME_COUNT))
    depth_count = int(depth_cap.get(cv2.CAP_PROP_FRAME_COUNT))
    mask_files = sorted(Path(masks).glob("mask_*.png"))
    if source_count != depth_count or source_count != len(mask_files):
        raise RuntimeError("Frame alignment failed (source/depth/SAM): %d/%d/%d" % (source_count, depth_count, len(mask_files)))
    codec = cv2.VideoWriter_fourcc(*"mp4v")
    comp = cv2.VideoWriter(str(composite_path), codec, fps, (width, height))
    over = cv2.VideoWriter(str(overlay_path), codec, fps, (width, height))
    mask_out = cv2.VideoWriter(str(mask_video_path), codec, fps, (width, height))
    report = []
    for i, mask_path in enumerate(mask_files):
        ok_s, rgb = source.read()
        ok_d, d = depth_cap.read()
        if not ok_s or not ok_d:
            raise RuntimeError("video ended before SAM mask %d" % i)
        mask = cv2.imread(str(mask_path), cv2.IMREAD_GRAYSCALE)
        if mask is None:
            raise RuntimeError("could not read SAM mask %s" % mask_path.name)
        if mask.shape != (height, width):
            mask = cv2.resize(mask, (width, height), interpolation=cv2.INTER_NEAREST)
        foreground = mask > 127
        n, labels, stats, _ = cv2.connectedComponentsWithStats(foreground.astype(np.uint8), 8)
        removed = 0
        for label in range(1, n):
            x, y, w, h, area = stats[label]
            touches_side = x == 0 or x + w >= width
            if touches_side and area < width * height * 0.03 and w <= max(6, int(width * 0.05)):
                foreground[labels == label] = False
                removed += int(area)
        mask = (foreground.astype(np.uint8) * 255)
        if d.shape[:2] != (height, width):
            d = cv2.resize(d, (width, height), interpolation=cv2.INTER_LINEAR)
        alpha = foreground[:, :, None]
        composed = np.where(alpha, d, rgb)
        blend = rgb.copy()
        green = np.zeros_like(rgb)
        green[:, :] = (0, 220, 80)
        blend[foreground] = (rgb[foreground] * 0.45 + green[foreground] * 0.55).astype(np.uint8)
        comp.write(composed)
        over.write(blend)
        mask_out.write(cv2.cvtColor(mask, cv2.COLOR_GRAY2BGR))
        report.append({"frame": i, "coverage": float(foreground.mean()), "removed_border_pixels": removed})
    source.release()
    depth_cap.release()
    comp.release()
    over.release()
    mask_out.release()
    for path in (composite_path, overlay_path, mask_video_path):
        to_h264(path)
    if not any(r["coverage"] > 0 for r in report):
        raise RuntimeError("SAM found no subject. Try a simpler segment prompt.")
    Path(report_path).write_text(json.dumps(report, indent=2))


if __name__ == "__main__":
    mode = sys.argv[1]
    if mode == "colorize":
        colorize(sys.argv[2], sys.argv[3])
    elif mode == "extract-mask-video":
        print(extract_masks(sys.argv[2], sys.argv[3]))
    elif mode == "composite":
        composite(*sys.argv[2:])
    else:
        raise SystemExit("unknown media helper")
