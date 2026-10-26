import type { ReshootAngle } from "../../server/shared";

/** Little top-down diagrams: the subject is the dot, the camera the triangle. */
export const ANGLE_ICON: Record<ReshootAngle, string> = {
  orbit_left: "M12 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0M5 12a7 7 0 0 1 7-7M5 9l0 3 3 0",
  orbit_right: "M12 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0M19 12a7 7 0 0 0-7-7M19 9l0 3-3 0",
  low_angle: "M12 5v9M9 8l3-3 3 3M5 20l7-4 7 4",
  high_angle: "M12 19v-9M9 16l3 3 3-3M5 4l7 4 7-4",
  overhead: "M12 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0M12 3v4M12 17v4M3 12h4M17 12h4",
  closeup: "M8 4H4v4M16 4h4v4M8 20H4v-4M16 20h4v-4M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0",
  wide: "M3 7h18v10H3zM12 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0",
  behind: "M12 9m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0M8 20c0-3 2-5 4-5s4 2 4 5M12 3v2",
  profile: "M14 9m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0M4 12h5M7 10l2 2-2 2",
  drone: "M12 14m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0M6 5h4M14 5h4M8 5v3l4 3 4-3V5",
};

export function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}
