import { RESHOOT_ANGLES, type ReshootAngle } from "./shared.js";
// Builds a Seedance 2.5 video-to-video prompt pack for Recast:
// @video1 = the take's depth map (motion, camera and layout only),
// @image1..N = the user's references. Structure follows the proven house
// style: source declaration + reference map, scene, per-second motion lock
// measured from the take, behaviour lock, look, negative prompt.

import type { MotionReport, MotionSecond } from "./motion.js";

export interface PackReference {
  tag: string; // "@image1"
  kind: "character" | "place";
  label: string; // the card's description
  url: string;
}

export interface PromptPack {
  prompt: string;
  negative: string;
  uploads: { tag: string; label: string; url: string }[];
  timeline: string[];
}

const fmt = (s: number) => `0:${String(s).padStart(2, "0")}`;

function cameraPhrase(s: MotionSecond): string {
  const parts: string[] = [];
  const mag = (v: number, slow: number, fast: number) => (Math.abs(v) >= fast ? "" : Math.abs(v) >= slow ? "slowly " : null);
  const pan = mag(s.pan, 0.03, 0.08);
  if (pan !== null) parts.push(`${pan}pans ${s.pan > 0 ? "right" : "left"}`);
  const tilt = mag(s.tilt, 0.03, 0.08);
  if (tilt !== null) parts.push(`${tilt}tilts ${s.tilt > 0 ? "up" : "down"}`);
  const push = mag(s.push, 0.015, 0.05);
  if (push !== null) parts.push(`${push}${s.push > 0 ? "pushes in" : "pulls back"}`);
  if (!parts.length) {
    const drift = Math.abs(s.pan) + Math.abs(s.tilt) > 0.015;
    return drift ? "the camera drifts very slightly" : "the camera holds steady";
  }
  return `the camera ${parts.join(" and ")}`;
}

function subjectPhrase(prev: MotionSecond | undefined, s: MotionSecond, name: string): string | null {
  if (!prev) return null;
  const dx = s.subjectX - prev.subjectX;
  const grow = prev.subjectSize > 0 ? s.subjectSize / prev.subjectSize : 1;
  const bits: string[] = [];
  if (Math.abs(dx) > 0.08) bits.push(`moves toward frame ${dx > 0 ? "right" : "left"}`);
  if (grow > 1.25) bits.push("comes closer to camera");
  else if (grow < 0.8) bits.push("moves away from camera");
  return bits.length ? `${name} ${bits.join(" and ")}` : null;
}

export function buildTimeline(motion: MotionReport, mainName: string): string[] {
  return motion.seconds.map((s, i) => {
    const end = Math.min(Math.ceil(motion.duration), s.t + 1);
    const cam = cameraPhrase(s);
    const subj = motion.hasSubject ? subjectPhrase(motion.seconds[i - 1], s, mainName) : null;
    const line = subj ? `${cam}; ${subj}` : cam;
    return `${fmt(s.t)}–${fmt(end)} — ${line.charAt(0).toUpperCase()}${line.slice(1)}.`;
  });
}

function timelineThrough(motion: MotionReport, duration: number, mainName: string): string[] {
  const seconds = motion.seconds.filter((s) => s.t < duration);
  return buildTimeline({ ...motion, duration: Math.min(motion.duration, duration), seconds }, mainName);
}

/** LTX Router accepts text only: carry measured motion forward as prose, not media refs. */
export function buildTextOnlyPrompt(o: {
  scene?: string;
  background?: string;
  characterLabels: string[];
  motion: MotionReport;
  duration: number;
  aspect: number;
}): string {
  const scene = o.scene?.trim().replace(/\s+/g, " ");
  const background = o.background?.trim().replace(/\s+/g, " ");
  const labels = o.characterLabels.map((s) => s.trim()).filter(Boolean);
  const orientation = o.aspect >= 1 ? "landscape" : "portrait";
  return [
    scene
      ? `Create a new video from this text direction: ${scene}`
      : "Create a cinematic video of a person in a natural setting.",
    labels.length ? `Selected character labels (text only; their images are not sent): ${labels.join(", ")}.` : "",
    background ? `Setting direction: ${background}` : "",
    `Approximate camera and on-screen subject movement measured from the source clip:\n${timelineThrough(o.motion, o.duration, "the subject").join("\n")}`,
    `Use one continuous shot with no cuts. Target duration: ${Math.round(o.duration)} seconds. Frame orientation: ${orientation}.`,
    "The source video and character images are not provided to this text-to-video model. Generate from this text and motion guide only.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** MiniMax H3 accepts images and text, but not the source video in this app flow. */
export function buildMiniMaxH3Prompt(o: {
  scene?: string;
  background?: string;
  characterLabels: string[];
  hasCharacterSheet: boolean;
  motion: MotionReport;
  duration: number;
  aspect: number;
}): string {
  const scene = o.scene?.trim().replace(/\s+/g, " ");
  const background = o.background?.trim().replace(/\s+/g, " ");
  const labels = o.characterLabels.map((s) => s.trim()).filter(Boolean);
  const orientation = o.aspect >= 1 ? "landscape" : "portrait";
  return [
    scene ? `Create a new video from this direction: ${scene}` : "Create a cinematic video with natural, coherent motion.",
    o.hasCharacterSheet
      ? `Use the attached character reference sheet for appearance only. Preserve each selected character's face, hair, skin tone, clothing and proportions consistently; do not copy a real person's identity or celebrity likeness.${labels.length ? ` The character labels are: ${labels.join(", ")}.` : ""}`
      : labels.length ? `Character direction: ${labels.join(", ")}.` : "Use original fictional characters.",
    background ? `Setting direction: ${background}` : "",
    `Approximate camera and subject movement measured from the source clip:\n${timelineThrough(o.motion, o.duration, "the subject").join("\n")}`,
    `Generate native audio that fits the scene, including natural ambience and suitable sound effects; add dialogue only when directed. Target duration: ${Math.round(o.duration)} seconds. Frame orientation: ${orientation}. Use one continuous shot without cuts.`,
    "The source video is not sent to the model. The motion notes are approximate; generate the visual scene and audio from this prompt and any attached character reference image.",
  ].filter(Boolean).join("\n\n");
}

export function buildPromptPack(o: {
  depthUrl: string;
  originalUrl: string;
  references: PackReference[];
  scene?: string;
  motion: MotionReport;
  look?: string;
  /** Characters combined on one reference sheet image, left to right. */
  sheet?: { tag: string; url: string; characters: number };
  /** Original footage sent as a second reference video: keep its background. */
  keepBackground?: { tag: string; url: string };
  /** With keepBackground off: the user's description of the new background. */
  background?: string;
  /** A prepared take is the one and only reference video (@video1). */
  preparedVideo?: boolean;
  /** No depth map: @video1 is the user's original footage. */
  sourceVideo?: boolean;
  /** Style swap: restyle the whole shot after the sheet image (used as-is). Needs sourceVideo. */
  restyle?: boolean;
  /** Re-shoot: the same moment filmed again from this viewpoint. Needs sourceVideo. */
  reshoot?: ReshootAngle;
  /** Visual style for every surface, character and the set (replaces the photoreal default). */
  style?: string;
}): PromptPack {
  if (o.reshoot && o.sourceVideo) return buildReshootPack({ ...o, reshoot: o.reshoot });
  if (o.restyle && o.sourceVideo && o.sheet) return buildRestylePack(o as typeof o & { sheet: { tag: string; url: string } });
  const chars = o.references.filter((r) => r.kind === "character");
  const places = o.references.filter((r) => r.kind === "place");
  const style = o.style?.trim().replace(/\s+/g, " ").replace(/([^.!?])$/, "$1.");
  const ordinal = ["main person", "second person", "third person", "fourth person", "fifth person"];

  const ordinalSheet = ["first (leftmost)", "second", "third", "fourth"];
  const mapping = o.sheet
    ? `${o.sheet.tag} is a character reference sheet: ${o.sheet.characters} character${o.sheet.characters > 1 ? "s" : ""} side by side on a plain grey background. ` +
      Array.from({ length: o.sheet.characters }, (_, i) =>
        i === 0
          ? `The ${ordinal[0]} in @video1 (the most prominent figure) becomes the ${ordinalSheet[0]} character on ${o.sheet!.tag}`
          : `the ${ordinal[i] ?? `person #${i + 1}`} becomes the ${ordinalSheet[i] ?? `#${i + 1}`} character on ${o.sheet!.tag}`,
      ).join("; ") +
      (o.keepBackground ? `. Anyone else keeps exactly their look from ${o.keepBackground.tag}.` : ". Anyone else in @video1 keeps their role, restyled to fit the scene.")
    : chars.length
    ? chars
        .map((c, i) =>
          i === 0
            ? `The ${ordinal[0]} in @video1 (the most prominent figure) becomes the character from ${c.tag}`
            : `the ${ordinal[i] ?? `person #${i + 1}`} becomes the character from ${c.tag}`,
        )
        .join("; ") + "."
    : "Keep every person's role and placement, restyled as described below.";
  const placeLine = places.length
    ? ` The location becomes the place shown in ${places.map((p) => p.tag).join(" and ")}, matched to the depth layout of @video1.`
    : "";

  const source = o.sourceVideo
    ? `@video1 is the original ${o.motion.handheld ? "handheld " : ""}footage of the shot. Follow it for the camera movement, the timing, the scene layout and every person's body motion and position. ${mapping}${placeLine}`
    : o.preparedVideo
    ? `There is one reference video. Its main figure is drawn as a colored depth silhouette (brighter is closer) over the scene's background. Follow @video1 for the camera movement, timing, scene layout, body motion and figure position. ${mapping}${placeLine}`
    : `@video1 is a grayscale depth map of a real ${o.motion.handheld ? "handheld " : ""}phone video: brighter means closer to the camera, darker means farther away. ` +
      `Use it ONLY for the camera movement, the timing, the scene layout and every person's body motion and position — ` +
      (o.keepBackground
        ? `it has no colors, textures or lighting of its own; the look comes from ${o.keepBackground.tag} and the reference sheet. ${mapping}${placeLine}`
        : `it has no colors, textures or lighting of its own; create all surfaces, faces, wardrobe and lighting fresh. ${mapping}${placeLine}`);

  const identity = o.sheet
    ? `Each character keeps the exact face, hair, skin tone, body proportions and wardrobe shown on the reference sheet in every frame; do not blend identities, and never show the grey sheet background.`
    : chars.length
    ? `Each referenced character keeps the exact face, hair, skin tone, body proportions and wardrobe of their image in every frame; do not blend identities between references.`
    : "";

  // no reference image: the swap is described in words only (the user's direction)
  const wordsOnly = !o.sheet && !chars.length && !!o.scene?.trim();
  const characterTag = o.sheet?.tag ?? chars[0]?.tag ?? "@Image1";
  // the look comes from the user's words, not the source footage
  const restyled = !!style || (!o.keepBackground && !o.sourceVideo && !o.preparedVideo);
  const videoDirection = wordsOnly ? "" : `${characterTag} is a character design reference sheet for an original fictional character.\n\nUse only the appearance traits from ${characterTag} (face structure, hair, skin tone, clothing, body proportions, and overall design). Do not copy any real-person identity or celebrity likeness. This is pure original fictional character design.\n\nStrictly follow the motion, timing, camera movement, framing, performance, and lip-sync from the source video. ${restyled ? "Everything else follows the scene and visual style described below." : "Keep everything else from the source video unchanged (background, lighting, other people, objects, and overall scene)."}\n\nApply the character from ${characterTag} cleanly and consistently across the entire clip with no identity drift.`;

  const keep = wordsOnly && o.sourceVideo
    ? `Keep everything in @video1 exactly as it is — the background, location, lighting, colors, camera and every movement — and change only what the direction below asks for.`
    : o.sourceVideo
    ? `Keep everything in @video1 exactly as it is — the background, location, lighting, colors and every other person and object — and replace only the person or people mapped above. The result must look like @video1 with only the character swapped.`
    : o.preparedVideo
    ? `Keep the background of @video1 as it is and replace only the depth-colored figure with the referenced character.`
    : o.keepBackground
      ? `${o.keepBackground.tag} is the original footage of the same shot. Keep everything in ${o.keepBackground.tag} exactly as it is — the background, location, set, lighting, colors, weather, and every other person and object — and replace only the person or people mapped above. The result must look like ${o.keepBackground.tag} with only the character swapped.`
      : "";
  const bg = o.background?.trim().replace(/\s+/g, " ").replace(/([^.!?])$/, "$1.");
  const scene = o.preparedVideo || o.sourceVideo
    ? `Scene: the setting and background visible in @video1.`
    : o.keepBackground
    ? `Scene: exactly the setting of ${o.keepBackground.tag}.`
    : bg
      ? `Scene: ${bg}`
      : places.length
        ? `Scene: the setting from ${places[0].tag}, lit naturally and consistently with it.`
        : `Scene: a realistic setting that fits the depth layout of @video1, naturally lit.`;
  // the user's own words add to the base prompt; they never replace the motion lock
  const userText = o.scene?.trim().replace(/\s+/g, " ").replace(/([^.!?])$/, "$1.");
  const direction = userText
    ? `Additional direction (apply to the look, setting, wardrobe and mood; it never changes the camera path or the performers' motion below): ${userText}`
    : "";

  const timeline = buildTimeline(o.motion, chars.length || o.sheet ? "the main person" : "the main subject");
  const shake = o.motion.handheld
    ? `Keep the natural handheld camera shake of ${o.preparedVideo ? "@video1" : "the original phone footage"}; the frame is never perfectly still.`
    : `Keep the camera exactly as smooth or as steady as @video1 — no added shake.`;

  const prompt = [
    videoDirection,
    source,
    keep,
    identity,
    scene,
    direction,
    style ? `Visual style: ${style} Apply it to every character, surface and the whole set, consistently in every frame; it never changes the camera path or the performers' motion.` : "",
    `Replicate the camera motion and the performers' motion of @video1 exactly, second by second — one continuous shot, no cuts:\n${timeline.join("\n")}`,
    `${shake} Bodies, limbs and heads follow @video1's silhouettes frame for frame: same steps, same gestures, same timing, same distance to camera.`,
    // with a user direction, let it set the style instead of forcing photorealism
    style
      ? `${o.look ? `${o.look}, ` : ""}rendered entirely in the visual style above, natural motion blur, ultra-detailed, 4K.`
      : `${o.look ? `${o.look}, ` : ""}${userText ? "in the style described above" : "photorealistic, natural skin texture"}, true-to-life motion blur, ultra-detailed, 4K.`,
  ]
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("\n\n");

  const negative = [
    "deviating from @video1's camera path",
    "cuts or scene changes",
    o.motion.handheld ? "tripod-smooth motion" : "added camera shake",
    "people changing position, pose or timing",
    "extra people",
    "identity drift between frames",
    "blended faces",
    "depth-map look, grayscale, monochrome",
    "morphing limbs, warped hands, melting faces",
    // a chosen style may be cartoon-like or saturated on purpose
    ...(style ? ["mixing styles between frames", "photographic footage showing through"] : ["cartoon or plastic look", "oversaturated colors"]),
    "text, watermark, logo",
  ].join(", ");

  const uploads = [
    { tag: "@video1", label: o.sourceVideo ? "Your original video" : o.preparedVideo ? "Prepared video (depth figure + pitched vocals)" : "Depth map of your video (motion reference)", url: o.sourceVideo ? o.originalUrl : o.depthUrl },
    ...(!o.preparedVideo && o.keepBackground ? [{ tag: o.keepBackground.tag, label: "Your original video (background reference)", url: o.keepBackground.url }] : []),
    ...(o.sheet ? [{ tag: o.sheet.tag, label: "Character reference sheet", url: o.sheet.url }] : []),
    ...o.references.map((r) => ({ tag: r.tag, label: `${r.kind === "place" ? "Place" : "Character"}: ${r.label}`, url: r.url })),
  ];

  return { prompt, negative, uploads, timeline };
}

/** Re-shoot: the same people, place and action as @video1, filmed again from a new
 *  camera position. The original camera path is not copied: that is what changes. */
function buildReshootPack(o: { originalUrl: string; scene?: string; motion: MotionReport; look?: string; reshoot: ReshootAngle; sheet?: { tag: string; url: string } }): PromptPack {
  const angle = RESHOOT_ANGLES[o.reshoot];
  const userText = o.scene?.trim().replace(/\s+/g, " ").replace(/([^.!?])$/, "$1.");
  // only the subject's action carries over: the original camera moves are exactly what a re-shoot replaces
  const timeline = buildTimeline(o.motion, "the main subject")
    .map((line) => {
      const [time, text = ""] = line.split(" — ");
      const kept = text.split(/(?<=\.)\s+/).filter((sentence) => sentence && !/\bcamera\b/i.test(sentence)).join(" ");
      return kept ? `${time} — ${kept}` : "";
    })
    .filter(Boolean);
  const prompt = [
    `Re-shoot of @video1 from a new camera angle: ${angle.camera}.`,
    `It is the same moment as @video1: the same people with the same faces, hair and clothes, the same place, the same lighting and time of day, and the same action happening at the same pace and in the same order. Only the camera position changes.`,
    `Show the setting as it really looks from the new viewpoint, keeping it consistent with what @video1 shows; parts the original camera never saw continue the same place naturally.`,
    o.sheet ? `Anyone matching ${o.sheet.tag} keeps that exact look.` : "",
    userText ? `Direction: ${userText}` : "",
    timeline.length ? `The action follows @video1's timing, second by second, seen from the new angle:\n${timeline.join("\n")}` : "The action follows @video1's timing exactly, seen from the new angle.",
    "One continuous shot, no cuts. Photorealistic, natural skin texture, true-to-life motion blur, ultra-detailed.",
  ]
    .filter(Boolean)
    .join("\n\n");
  const negative = [
    "the same camera angle as @video1",
    "cuts or scene changes",
    "changed faces, hair or clothes",
    "extra or missing people",
    "a different place or time of day",
    "warped or melting geometry",
    "morphing limbs, warped hands",
    "text, watermark, logo",
  ].join(", ");
  const uploads = [
    { tag: "@video1", label: "Your original video (what happens)", url: o.originalUrl },
    ...(o.sheet ? [{ tag: o.sheet.tag, label: "Character reference", url: o.sheet.url }] : []),
  ];
  return { prompt, negative, uploads, timeline };
}

/** Style swap: @video1 keeps the motion and framing, the reference image sets the
 *  design of the moving subject and the look of the whole shot. No person mapping. */
function buildRestylePack(o: { originalUrl: string; scene?: string; motion: MotionReport; look?: string; sheet: { tag: string; url: string } }): PromptPack {
  const ref = o.sheet.tag;
  const userText = o.scene?.trim().replace(/\s+/g, " ").replace(/([^.!?])$/, "$1.");
  const timeline = buildTimeline(o.motion, "the main subject");
  const prompt = [
    `Full style swap of @video1. ${ref} is a design and style reference, not a person: copy its shape language, materials, colors, surface finish and lighting mood.`,
    `@video1 is the original ${o.motion.handheld ? "handheld " : ""}footage of the shot. Follow it exactly for the camera movement, the timing, the framing, the scene layout and the path and speed of everything that moves.`,
    `The main moving subject of @video1 is redesigned to match ${ref} and keeps that exact design in every frame. The rest of the shot is restyled to sit naturally with it, keeping the same layout and the same place in frame.`,
    userText ? `Direction: ${userText}` : "",
    `Replicate the camera motion and the subject's motion of @video1 exactly, second by second — one continuous shot, no cuts:\n${timeline.join("\n")}`,
    o.motion.handheld ? "Keep the natural handheld camera shake of the original footage." : "Keep the camera exactly as smooth or as steady as @video1.",
    `${o.look ? `${o.look}, ` : ""}photorealistic, cinematic lighting, true-to-life motion blur, ultra-detailed.`,
  ]
    .filter(Boolean)
    .join("\n\n");
  const negative = [
    "deviating from @video1's camera path",
    "cuts or scene changes",
    o.motion.handheld ? "tripod-smooth motion" : "added camera shake",
    "the original subject left unchanged",
    "design drift between frames",
    "morphing or melting shapes",
    "cartoon or plastic look",
    "text, watermark, logo",
  ].join(", ");
  const uploads = [
    { tag: "@video1", label: "Your original video", url: o.originalUrl },
    { tag: ref, label: "Style reference", url: o.sheet.url },
  ];
  return { prompt, negative, uploads, timeline };
}

/** MiniMax H3 character swap (Ref2VA + character swap LoRA): <Video 1> is the
 *  take, <Picture 1> the character. Structure follows Akatz's tested prompt. */
export function buildH3SwapPrompt(o: { characters: number; direction?: string; sheet: boolean; silhouette?: boolean }): string {
  const who = o.characters > 1 ? "the people" : "the person";
  const ref = o.sheet
    ? `<Picture 1> is a character sheet with ${o.characters} characters left to right; the most prominent person in <Video 1> becomes the leftmost character${o.characters > 1 ? ", the next most prominent the second, and so on" : ""}.`
    : "";
  const direction = o.direction?.trim().replace(/\s+/g, " ").replace(/([^.!?])$/, "$1.");
  // a SAM 3 prepared take: the person is already cut out as a colored depth silhouette over the real background
  const silhouette = o.silhouette
    ? `In <Video 1> the person to replace is drawn as a colored depth silhouette (brighter is closer to the camera) over the real background. Render that silhouette as the character from <Picture 1>, fully photoreal, following the silhouette's exact outline, pose and movement in every frame; no trace of the silhouette colors may remain.`
    : "";
  return [
    `Replace ${o.silhouette ? "the colored silhouette figure" : who} in <Video 1> with the character shown in <Picture 1>. ${ref} ${silhouette}`.trim(),
    `subject_definitions:\n<Subject 1> is the replacement character whose appearance comes from <Picture 1> and whose performance comes from the person being replaced in <Video 1>. Preserve the reference character's facial features, hairstyle, skin tone, body proportions, clothing, colors and distinctive visual style. <Picture 1> supplies appearance only, not pose, expression, background or framing.\n<Subject 2> is the surrounding scene from <Video 1>: background, lighting, objects and any other people.\n<Video 1> is the source video being edited; it supplies the shot composition, camera movement, timing and sequence of actions.`,
    `summary:\n[video editing + reference generation] The target video is an edited version of <Video 1>. Replace the original person with <Subject 1>, transferring their complete visible performance to the reference character while preserving <Subject 2> and the source video's framing and timing.`,
    `retention_analysis:\n<Subject 1> (throughout [Shot 1]): fully_preserved - keep the referenced identity, clothing, proportions and style as the character performs the source movements.\n<Subject 2> (throughout [Shot 1]): fully_preserved - keep the surrounding scene and its changes over time.\n<Video 1>: partially_preserved - keep composition, camera motion, action timing and duration; replace only the selected person's appearance.`,
    `detailed_description:\n[Shot 1] Begin with the same composition and camera viewpoint as <Video 1>. <Subject 1> occupies the original person's position and follows their movement through the frame, matching the performance moment by moment: posture, gestures, head turns, gaze, blinking, facial expressions and mouth movements. Hair and clothing move naturally. Keep the source crop and shot scale; do not widen the shot to show the full-body reference, and do not import the reference image's background, pose or props. Adapt lighting, shading and perspective to the source scene.${direction ? `\nAdditional direction (look and styling only; never the motion or framing): ${direction}` : ""}`,
    `overall_soundscape:\nRetain the source clip's existing sound without adding new dialogue or sound effects.`,
  ].join("\n\n");
}
