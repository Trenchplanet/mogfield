"""comfyui-backlot: CameraRig, LensKit, GradeLUT, Letterbox and ShotCard.

Real camera paths and real optics for ComfyUI video workflows.
"""

try:
    from .backlot.nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS
except ImportError:  # imported outside ComfyUI, e.g. by pytest's collector
    from backlot.nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
