import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { H3_DEFAULT_LORA, LENSES, findVideoLink, linkSource, type CastCard, type Clip, type DepthJob, type LensName, type Preparation, type PromptPack, type Render, type RenderParams } from "../server/shared";
import { api, type Health, type ModelOption, type Quality } from "./api";
import { estimateUsd, formatUsd } from "../server/providers/pricing";
import { EasyPanel } from "./components/EasyPanel";
import { AgentPage } from "./components/AgentPage";
import { Library, type DragItem } from "./components/Library";
import { CharacterMaker } from "./components/CharacterMaker";
import type { Trim } from "./components/VideoCard";
import { PRESET_LABEL } from "./camera";
import { Gallery } from "./components/Gallery";
import { Monitor, type MonitorHandle } from "./components/Monitor";
import { GraphView, PackSheet, ShareSheet } from "./components/Overlays";
import { ControlPanel } from "./components/Panel";
import { PreparationSheet } from "./components/PreparationSheet";
import { LibraryPage } from "./components/LibraryPage";
import { CharacterStudio } from "./components/CharacterStudio";
import { BackendSheet } from "./components/BackendSheet";
import { VideoPage, type EditTool, type VideoSub } from "./components/VideoPage";
import { RestylePage } from "./components/RestylePage";
import { ImagePage } from "./components/ImagePage";
import { QueueButton, QueueList, queueBusy, queueCount, queueItems, type QueueItem } from "./components/Queue";
import { DEFAULT_DIRECTION, effective, type Direction } from "./state";
import { saveToPhotos } from "./save";

type Tab = "studio" | "how" | "library" | "characters" | "video" | "agent";

/** Where you are lives in the address (?page=video&sub=edit&tool=extend): reloads, links and Back land in the same place. */
const PAGE_SLUG: Record<Tab, string> = { characters: "image", video: "video", studio: "swap", library: "library", how: "how", agent: "agent" };
type Level = "easy" | "pro";
type Nav = { tab: Tab; sub: VideoSub; tool: EditTool | null; level?: Level };
function readNav(fromStorage = true): Nav {
  let q = new URLSearchParams(location.search);
  if (!q.get("page") && fromStorage) {
    try {
      q = new URLSearchParams(localStorage.getItem("mogfield.nav") ?? "");
    } catch {
      /* private mode */
    }
  }
  const page = q.get("page");
  // older links: the separate Text to video and Re-shoot pages now live under Video
  if (page === "t2v") return { tab: "video", sub: "create", tool: null };
  if (page === "reshoot") return { tab: "video", sub: "edit", tool: "reshoot" };
  if (page === "restyle") return { tab: "video", sub: "restyle", tool: null };
  const tab = (Object.keys(PAGE_SLUG) as Tab[]).find((t) => PAGE_SLUG[t] === page) ?? "studio";
  const mode = q.get("mode");
  if (tab === "studio" || tab === "how") return { tab, sub: "create", tool: null, level: mode === "pro" ? "pro" : mode === "easy" ? "easy" : undefined };
  const tool = q.get("tool");
  const sub = q.get("sub");
  if (sub === "restyle") return { tab, sub, tool: null };
  // Edit has no list page any more: it opens on Extend
  if (sub === "edit") return { tab, sub, tool: tool === "reshoot" ? "reshoot" : "extend" };
  return { tab, sub: "create", tool: null };
}
function navQuery(n: Nav): string {
  const q = new URLSearchParams({ page: PAGE_SLUG[n.tab] });
  if (n.tab === "video") {
    q.set("sub", n.sub);
    if (n.sub === "edit" && n.tool) q.set("tool", n.tool);
  }
  if ((n.tab === "studio" || n.tab === "how") && n.level) q.set("mode", n.level);
  return `?${q}`;
}

/** The menu: four places, each with its own options in the bar below it. */
const MENU: { tab: Tab; label: string }[] = [
  { tab: "video", label: "Video" },
  { tab: "characters", label: "Image" },
  { tab: "studio", label: "Character Swap" },
  { tab: "library", label: "Library" },
  { tab: "agent", label: "Agent" },
];

/** Video's options, side by side in one bar. */
const VIDEO_OPTIONS: { label: string; sub: VideoSub; tool: EditTool | null }[] = [
  { label: "Create", sub: "create", tool: null },
  { label: "Extend", sub: "edit", tool: "extend" },
  { label: "Re-shoot", sub: "edit", tool: "reshoot" },
  { label: "Restyle", sub: "restyle", tool: null },
];

function sameTrim(a?: { start: number; end: number }, b?: { start: number; end: number }) {
  return (!a && !b) || (!!a && !!b && Math.abs(a.start - b.start) < 0.051 && Math.abs(a.end - b.end) < 0.051);
}

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [backendOpen, setBackendOpen] = useState<false | "cloud" | "custom">(false);
  const [clips, setClips] = useState<Clip[]>([]);
  const [luts, setLuts] = useState<string[]>([]);
  const [renders, setRenders] = useState<Render[]>([]);
  const [casts, setCasts] = useState<CastCard[]>([]); // references picked for this generation
  const [images, setImages] = useState<CastCard[]>([]); // every image in the library
  const [libraryFor, setLibraryFor] = useState<"video" | "image" | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [trims, setTrims] = useState<Record<string, Trim>>({});
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [easyPromptOn, setEasyPromptOn] = useState(false);
  const [keepBackground, setKeepBackground] = useState(true);
  const [background, setBackground] = useState("");
  const [makerOpen, setMakerOpen] = useState(false);
  const [clipId, setClipId] = useState<string | null>(null);
  const [renderId, setRenderId] = useState<string | null>(null);
  const [dir, setDir] = useState<Direction>(DEFAULT_DIRECTION);
  const [level, setLevelState] = useState<"easy" | "pro">(() => {
    try {
      // a link to Pro opens Pro; otherwise the last one you used
      const fromUrl = new URLSearchParams(location.search).get("mode");
      if (fromUrl === "pro" || fromUrl === "easy") return fromUrl;
      return localStorage.getItem("backlot.level") === "pro" ? "pro" : "easy";
    } catch {
      return "easy";
    }
  });
  const [mode, setMode] = useState<"direct" | "recast">(level === "easy" ? "recast" : "direct");
  const [models, setModels] = useState<ModelOption[]>([]);
  const [model, setModelState] = useState<string>(() => {
    try {
      // .v2: H3 character swap became the first model, so earlier saved choices start over on it
      return localStorage.getItem("mogfield.model.v2") ?? "";
    } catch {
      return "";
    }
  });
  const [quality, setQuality] = useState<Quality>("720p");
  const [lora, setLora] = useState<string>(H3_DEFAULT_LORA); // MiniMax H3 character swap
  const [useDepth, setUseDepthState] = useState<boolean>(() => {
    try {
      return localStorage.getItem("mogfield.useDepth") !== "no";
    } catch {
      return true;
    }
  });
  const setUseDepth = (on: boolean) => {
    setUseDepthState(on);
    try {
      localStorage.setItem("mogfield.useDepth", on ? "yes" : "no");
    } catch {
      /* private mode */
    }
  };
  const setModel = (id: string) => {
    setModelState(id);
    const m = models.find((x) => x.id === id);
    if (m && !m.qualities.includes(quality)) setQuality(m.qualities.includes("720p") ? "720p" : m.qualities[0]);
    try {
      localStorage.setItem("mogfield.model.v2", id);
    } catch {
      /* private mode */
    }
  };
  const [pack, setPack] = useState<{ loading: string | null; pack: PromptPack | null; error: string | null } | null>(null);
  const setLevel = (l: "easy" | "pro") => {
    setLevelState(l);
    if (l === "easy") setMode("recast");
    try {
      localStorage.setItem("backlot.level", l);
    } catch {
      /* private mode */
    }
  };
  const [prompt, setPrompt] = useState("");
  const [nav0] = useState(readNav);
  const [tab, setTab] = useState<Tab>(nav0.tab);
  const [videoSub, setVideoSub] = useState<VideoSub>(nav0.sub);
  const [imageSub, setImageSub] = useState<"image" | "character">(() => {
    try {
      return localStorage.getItem("mogfield.imageSub") === "character" ? "character" : "image";
    } catch {
      return "image";
    }
  });
  const goImage = (s: "image" | "character") => {
    setImageSub(s);
    try {
      localStorage.setItem("mogfield.imageSub", s);
    } catch {
      /* private mode */
    }
  };
  const [videoTool, setVideoTool] = useState<EditTool | null>(nav0.tool);
  const goVideo = useCallback((sub: VideoSub, tool: EditTool | null) => {
    setTab("video");
    setVideoSub(sub);
    setVideoTool(sub === "edit" ? tool ?? "extend" : null);
  }, []);
  // pages you have opened stay mounted (hidden), so their settings survive switching around
  const [seen, setSeen] = useState<Set<Tab>>(() => new Set([nav0.tab]));
  useEffect(() => setSeen((s) => (s.has(tab) ? s : new Set(s).add(tab))), [tab]);
  const firstNav = useRef(true);
  useEffect(() => {
    const q = navQuery({ tab, sub: videoSub, tool: videoTool, level });
    if (location.search !== q) history[firstNav.current ? "replaceState" : "pushState"](null, "", q);
    firstNav.current = false;
    try {
      localStorage.setItem("mogfield.nav", q);
    } catch {
      /* private mode */
    }
  }, [tab, videoSub, videoTool, level]);
  useEffect(() => {
    const onPop = () => {
      const n = readNav(false);
      setTab(n.tab);
      setVideoSub(n.sub);
      setVideoTool(n.tool);
      if (n.level) {
        setLevelState(n.level);
        if (n.level === "easy") setMode("recast");
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const [developing, setDeveloping] = useState<{ id: string; progress: number; frame: string | null; message: string } | null>(null);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [sharing, setSharing] = useState<Render | null>(null);
  const [preparation, setPreparation] = useState<Preparation | null>(null);
  const [preparations, setPreparations] = useState<Preparation[]>([]); // every preparation the server knows (queue + templates)
  const [queueOpen, setQueueOpen] = useState(false);
  const stopWatch = useRef<(() => void) | null>(null);
  const [preparationOpen, setPreparationOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [depthJobs, setDepthJobs] = useState<Record<string, DepthJob>>({});
  const [showDepth, setShowDepth] = useState(false);
  const monitor = useRef<MonitorHandle>(null);

  const set = useCallback((patch: Partial<Direction>) => setDir((d) => ({ ...d, ...patch })), []);
  const say = useCallback((m: string) => {
    setToast(m);
    setTimeout(() => setToast((t) => (t === m ? null : t)), 4200);
  }, []);

  const clip = clips.find((c) => c.id === clipId) ?? null;
  // longest window the chosen model accepts (Seedance 2.5: 30 s); Pro previews up to 30 s
  const maxSeconds = level === "easy" || mode === "recast" ? (models.find((m) => m.id === model)?.maxSeconds ?? 30) : 30;
  const recasting = level === "easy" || mode === "recast";
  const currentModel = models.find((m) => m.id === model);
  const savedTrim = clip ? trims[clip.id] : undefined;
  const trim: Trim = savedTrim
    ? { start: savedTrim.start, end: Math.min(savedTrim.end, savedTrim.start + maxSeconds) }
    : { start: 0, end: Math.min(clip?.duration ?? 0, maxSeconds) };
  const requestTrim = clip && trim.end - trim.start < clip.duration - 0.05 ? trim : undefined;
  const activePreparation = preparation && clip && preparation.clipId === clip.id && sameTrim(preparation.trim, requestTrim) ? preparation : null;
  // estimated cost of this generation, from the model's published rates
  // Seedance 2.5 recasts send only the prepared video; other models may add the original as a second video
  const preparedModel = model.includes("seedance-2-5");
  const costUsd = clip && recasting && currentModel?.pricing
    ? estimateUsd(currentModel.pricing, { seconds: trim.end - trim.start, quality, aspect: clip.width / clip.height, inputVideos: preparedModel || !keepBackground || !useDepth ? 1 : 2 })
    : null;
  const costLabel = costUsd !== null ? `${preparedModel ? `${quality} · ` : ""}${formatUsd(costUsd)}` : null;
  const setTrim = (t: Trim) => clip && setTrims((m) => ({ ...m, [clip.id]: t }));
  const render = renders.find((r) => r.id === renderId) ?? null;
  const revealClip = render ? clips.find((c) => c.id === render.params.clipId) ?? clip : clip;
  const finalCostUsd = render?.isDraft && render.params.model && revealClip
    ? estimateUsd(models.find((m) => m.id === render.params.model)?.pricing, {
        seconds: render.params.trim ? render.params.trim.end - render.params.trim.start : revealClip.duration,
        quality: "1080p",
        aspect: revealClip.width / revealClip.height,
        inputVideos: render.params.keepBackground === false ? 1 : 2,
      })
    : null;
  const finalCostLabel = finalCostUsd !== null ? formatUsd(finalCostUsd) : null;
  const view: "live" | "reveal" = render?.status === "succeeded" || (render?.status === "failed" && !!render.isDraft && !!render.draftUrl) ? "reveal" : "live";
  const busy = !!developing;
  // What actually applies: Easy is always "as shot"; Pro applies the sections switched on
  const live: Direction = useMemo(
    () => (level === "easy" ? effective({ ...dir, on: { camera: false, lens: false, color: false, frame: false } }, "recast") : effective(dir, mode)),
    [dir, level, mode],
  );

  const [readyTake, setReadyTake] = useState<Render | null>(null); // the take that just finished: download pill at the top
  const upsert = (r: Render) => setRenders((rs) => [r, ...rs.filter((x) => x.id !== r.id)].sort((a, b) => b.createdAt - a.createdAt));

  /** Show a take's live progress until it finishes; works for a take started on another page or before a reload. */
  const followRender = useCallback((r: Render) => {
    stopWatch.current?.();
    setRenderId(r.id);
    setGenerationError(null);
    setDeveloping({ id: r.id, progress: r.progress, frame: null, message: r.status === "queued" ? "Queued" : r.message });
    stopWatch.current = api.watch(r.id, (ev) => {
      if (ev.type === "progress") setDeveloping((d) => (d && d.id === r.id ? { ...d, progress: ev.progress, message: ev.message } : d));
      if (ev.type === "preview") setDeveloping((d) => (d && d.id === r.id ? { ...d, frame: ev.dataUrl } : d));
      if (ev.type === "status") {
        upsert(ev.render);
        if (ev.render.status === "succeeded") {
          setDeveloping((d) => (d && d.id === r.id ? null : d));
          setRenderId(ev.render.id);
          if (ev.render.url) setReadyTake(ev.render);
        } else if (ev.render.status === "failed") {
          setDeveloping((d) => (d && d.id === r.id ? null : d));
          setRenderId(ev.render.id);
          setGenerationError(ev.render.error ?? "Comfy could not complete this render.");
          say(`Take ${ev.render.take} failed: ${ev.render.error ?? "unknown error"}`);
        }
      }
    });
  }, [say]);

  /** Server state for the queue and the Library: every preparation and take. */
  const refreshJobs = useCallback(async () => {
    const [ps, rs] = await Promise.all([api.preparations().catch(() => null), api.renders().catch(() => null)]);
    if (ps) {
      setPreparations(ps);
      // keep an open preparation sheet current even when live updates cannot get through
      setPreparation((cur) => (cur ? ps.find((x) => x.id === cur.id) ?? cur : cur));
    }
    if (rs) setRenders(rs);
    return rs;
  }, []);

  useEffect(() => {
    void api.health().then(setHealth).catch(() => say("Server offline - run npm run dev"));
    void api.luts().then(setLuts).catch(() => {});
    void api.library().then(setImages).catch(() => {});
    void api.models().then((ms) => {
      setModels(ms);
      // default: the first connected model, else the first listed
      // a LoRA that is not on the account yet would fail the render: start on one that is
      const loras = ms.find((m) => m.loras)?.loras ?? [];
      setLora((l) => (loras.some((x) => x.id === l && x.installed) ? l : loras.find((x) => x.installed && x.id !== "none")?.id ?? "none"));
      const pick = (cur: string) => (ms.some((m) => m.id === cur) ? cur : (ms.find((m) => m.available) ?? ms[0])?.id ?? "");
      setModelState((cur) => {
        const id = pick(cur);
        const qs = ms.find((m) => m.id === id)?.qualities ?? [];
        setQuality((q) => (qs.length && !qs.includes(q) ? (qs.includes("720p") ? "720p" : qs[0]) : q));
        return id;
      });
    }).catch(() => {});
    void refreshJobs().then((rs) => {
      const live = rs?.find((r) => r.status === "running" || r.status === "queued");
      if (live) followRender(live);
    });
    void api.clips().then((c) => {
      setClips(c);
      setClipId((cur) => cur ?? c.find((x) => !x.sample)?.id ?? c[0]?.id ?? null);
    }).catch(() => {});
  }, [say, refreshJobs, followRender]);

  // queue polling: quick while something runs or the queue/Library is open, otherwise slow
  const queue = useMemo(() => queueItems(preparations, renders), [preparations, renders]);
  const queueActive = queueBusy(queue);
  useEffect(() => {
    const ms = queueActive ? 2500 : queueOpen || tab === "library" ? 5000 : 20000;
    const t = setInterval(() => void refreshJobs(), ms);
    return () => clearInterval(t);
  }, [queueActive, queueOpen, tab, refreshJobs]);


  const generate = useCallback(async () => {
    if (!clip || developing) return;
    // H3 only swaps the person when it gets the SAM 3 silhouette take or an installed swap LoRA
    const h3Lora = models.find((m) => m.id === model)?.loras?.find((l) => l.id === lora);
    const h3NeedsPrep = model.startsWith("h3:") && !(h3Lora && h3Lora.id !== "none" && h3Lora.installed);
    // Use Depth Map off: no depth, no SAM 3 prep; the model gets the original video
    const needsGenjustsu = useDepth && (level === "easy" || mode === "recast") && ((model.startsWith("comfy:") && model.includes("seedance-2-5")) || h3NeedsPrep);
    const approvedPreparation = preparation && preparation.clipId === clip.id && sameTrim(preparation.trim, requestTrim) && preparation.status === "ready" && preparation.approved ? preparation : null;
    if (needsGenjustsu && !approvedPreparation) {
      setPreparationOpen(true);
      return;
    }
    setTab("studio");
    setRenderId(null);
    setGenerationError(null);
    setDeveloping({ id: "", progress: 0, frame: null, message: "Starting" });
    const d = live;
    const params: RenderParams = {
      clipId: clip.id,
      mode,
      camera: d.camera,
      cameraStrength: d.cameraStrength,
      lens: d.lens,
      fStop: d.fStop,
      focus: d.focus,
      focusEnd: d.rackFocus ? d.focusEnd : -1,
      lut: d.lut,
      lutStrength: d.lutStrength,
      grain: d.grain,
      halation: d.halation,
      aspect: d.aspect,
      castId: casts.find((c) => c.kind === "character")?.id,
      prompt: level === "easy" ? (easyPromptOn && prompt.trim() ? prompt.trim() : undefined) : prompt || undefined,
      seed: Math.floor(Math.random() * 2 ** 31),
      trim: requestTrim,
      keepBackground,
      background: keepBackground ? undefined : background.trim() || undefined,
      ...(level === "easy" || mode === "recast" ? { model, quality, castIds: casts.filter((c) => c.kind === "character").map((c) => c.id) } : {}),
      ...(approvedPreparation && useDepth ? { preparationId: approvedPreparation.id } : {}),
      ...(useDepth ? {} : { useDepth: false }),
      ...(model.startsWith("h3:") ? { lora } : {}),
    };
    try {
      const r = await api.render(params);
      upsert(r);
      followRender(r);
    } catch (e) {
      setDeveloping(null);
      setGenerationError((e as Error).message);
      say((e as Error).message);
    }
  }, [clip, developing, mode, live, level, casts, prompt, easyPromptOn, model, quality, requestTrim, keepBackground, background, preparation, lora, models, useDepth, say, followRender]);

  /** Restyle tab: the take's motion (depth map) with new characters, world and style. */
  const startRestyle = useCallback(
    async (o: { castIds: string[]; style: string; scene?: string; model: string; quality: Quality; trim?: Trim }) => {
      if (!clip) return;
      const params: RenderParams = {
        clipId: clip.id,
        mode: "recast",
        camera: "static",
        cameraStrength: 0,
        lens: DEFAULT_DIRECTION.lens,
        fStop: DEFAULT_DIRECTION.fStop,
        focus: DEFAULT_DIRECTION.focus,
        focusEnd: -1,
        lut: "none",
        lutStrength: 0,
        grain: 0,
        halation: 0,
        aspect: "native",
        model: o.model,
        quality: o.quality,
        castIds: o.castIds,
        // the look comes from the style and the scene, not the original footage
        keepBackground: false,
        background: o.scene,
        style: o.style,
        trim: o.trim,
        seed: Math.floor(Math.random() * 2 ** 31),
      };
      try {
        upsert(await api.render(params));
        say("Restyle started. It shows here and in the queue.");
      } catch (e) {
        say((e as Error).message);
      }
    },
    [clip, say],
  );

  /** Re-shoot tab: the take filmed again from another angle (original video in, no depth). */
  const startReshoot = useCallback(
    async (o: { angle: NonNullable<RenderParams["reshoot"]>; view?: RenderParams["reshootView"]; direction?: string; model: string; quality: Quality; trim?: Trim }) => {
      if (!clip) return;
      const params: RenderParams = {
        clipId: clip.id,
        mode: "recast",
        camera: "static",
        cameraStrength: 0,
        lens: DEFAULT_DIRECTION.lens,
        fStop: DEFAULT_DIRECTION.fStop,
        focus: DEFAULT_DIRECTION.focus,
        focusEnd: -1,
        lut: "none",
        lutStrength: 0,
        grain: 0,
        halation: 0,
        aspect: "native",
        model: o.model,
        quality: o.quality,
        prompt: o.direction,
        trim: o.trim,
        keepBackground: true,
        useDepth: false,
        reshoot: o.angle,
        reshootView: o.view,
        seed: Math.floor(Math.random() * 2 ** 31),
      };
      try {
        upsert(await api.render(params));
        say("Re-shoot started. It shows here and in the queue.");
      } catch (e) {
        say((e as Error).message);
      }
    },
    [clip, say],
  );

  const finalizeDraft = useCallback(async (draft: Render) => {
    if (developing || !draft.isDraft || !draft.draftTaskId) return;
    setTab("studio");
    setGenerationError(null);
    setDeveloping({ id: draft.id, progress: 0, frame: null, message: "Starting 1080p final" });
    try {
      const r = await api.finalizeDraft(draft.id);
      upsert(r);
      setRenderId(r.id);
      setDeveloping({ id: r.id, progress: 0, frame: null, message: r.message });
      api.watch(r.id, (ev) => {
        if (ev.type === "progress") setDeveloping((d) => (d && d.id === r.id ? { ...d, progress: ev.progress, message: ev.message } : d));
        if (ev.type === "status") {
          upsert(ev.render);
          if (ev.render.status === "succeeded") setDeveloping(null);
          else if (ev.render.status === "failed") {
            setDeveloping(null);
            setGenerationError(ev.render.error ?? "Comfy could not complete this render.");
            say(`Final render failed: ${ev.render.error ?? "unknown error"}`);
          }
        }
      });
    } catch (e) {
      setDeveloping(null);
      setGenerationError((e as Error).message);
      say((e as Error).message);
    }
  }, [developing, say]);

  /** Load a preparation's clip and trim; open its sheet to review, approve or watch it run. */
  const openPreparation = useCallback((prep: Preparation, openSheet: boolean) => {
    const c = clips.find((x) => x.id === prep.clipId);
    if (!c) {
      say("That clip is no longer in your library.");
      return;
    }
    // prepared takes run on Seedance 2.5 or H3 character swap; keep H3 when it is picked
    const seedance = models.find((m) => m.available && m.id.includes("seedance-2-5"));
    if (seedance && !model.includes("seedance-2-5") && !model.startsWith("h3:")) setModel(seedance.id);
    if (level === "pro") setMode("recast");
    setClipId(c.id);
    setTrims((m) => ({ ...m, [c.id]: prep.trim ?? { start: 0, end: c.duration } }));
    setRenderId(null);
    setGenerationError(null);
    setPreparation(prep);
    setTab("studio");
    setQueueOpen(false);
    if (openSheet) setPreparationOpen(true);
  }, [clips, models, model, level, say]); // eslint-disable-line react-hooks/exhaustive-deps

  const applyTemplate = useCallback((prep: Preparation) => {
    openPreparation(prep, !prep.approved);
    if (prep.approved) say("Template loaded. Pick a character and tap Generate.");
  }, [openPreparation, say]);

  const openQueueItem = useCallback((item: QueueItem) => {
    if (item.kind === "prep") {
      openPreparation(item.prep, true);
      return;
    }
    const r = item.render;
    setQueueOpen(false);
    setTab("studio");
    setClipId(r.params.clipId);
    if (r.status === "queued" || r.status === "running") {
      followRender(r);
      return;
    }
    setRenderId(r.id);
    setGenerationError(r.status === "failed" ? r.error ?? r.message : null);
  }, [openPreparation, followRender]);

  const dismissQueueItem = useCallback((item: QueueItem) => {
    const done = item.kind === "prep" ? api.dismissPreparation(item.prep.id) : api.dismissRender(item.render.id);
    void done.then(() => refreshJobs()).catch((e) => say((e as Error).message));
  }, [refreshJobs, say]);

  useEffect(() => {
    if (!queueOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setQueueOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [queueOpen]);

  const developingSteps = developing ? renders.find((r) => r.id === developing.id)?.steps : render?.status === "failed" ? render.steps : undefined;

  const swapLens = useCallback((d: number) => {
    const names = Object.keys(LENSES) as LensName[];
    setDir((cur) => {
      const i = names.indexOf(cur.lens);
      const n = names[(i + d + names.length) % names.length];
      return { ...cur, lens: n, fStop: Math.max(cur.fStop, LENSES[n].tstop) };
    });
  }, []);


  /** Resolves when the depth map exists; reports progress through onProgress. */
  const ensureDepth = useCallback(
    (c: Clip, onProgress?: (j: DepthJob) => void, reveal = true) =>
      new Promise<void>((resolve, reject) => {
        if (c.depthUrl) return resolve();
        const id = c.id;
        api
          .depth(id)
          .then((job) => {
            setDepthJobs((m) => ({ ...m, [id]: job }));
            onProgress?.(job);
            api.watchDepth(id, (j) => {
              setDepthJobs((m) => ({ ...m, [id]: j }));
              onProgress?.(j);
              if (j.status === "succeeded" && j.url) {
                setClips((cs) => cs.map((x) => (x.id === id ? { ...x, depthUrl: j.url } : x)));
                if (reveal) setShowDepth(true);
                resolve();
              }
              if (j.status === "failed") reject(new Error(`Depth failed: ${j.error ?? "unknown error"}`));
            });
          })
          .catch(reject);
      }),
    [],
  );

  const generateDepth = useCallback(async () => {
    if (!clip) return;
    try {
      await ensureDepth(clip);
    } catch (e) {
      say((e as Error).message);
    }
  }, [clip, ensureDepth, say]);

  // Start the depth map as soon as a take is picked: Pro shows it beside the
  // take; Easy keeps it out of sight so Generate can skip that step
  const depthRequested = useRef(new Set<string>());
  useEffect(() => {
    if (!clip || clip.depthUrl || depthRequested.current.has(clip.id)) return;
    depthRequested.current.add(clip.id);
    // Easy stays quiet: Generate makes the depth map itself if this one failed
    ensureDepth(clip, undefined, false).catch((e) => level === "pro" && say((e as Error).message));
  }, [clip, ensureDepth, say, level]);

  const makePack = useCallback(async () => {
    if (!clip) return;
    setPack({ loading: "Preparing…", pack: null, error: null });
    try {
      await ensureDepth(clip, (j) => setPack((s) => s && { ...s, loading: `Mapping depth · ${Math.round(j.progress * 100)}%` }), false);
      setPack((s) => s && { ...s, loading: "Measuring camera and character motion…" });
      const result = await api.pack({
        clipId: clip.id,
        castIds: casts.map((c) => c.id),
        prompt: prompt || undefined,
        look: level === "pro" && live.lut !== "none" ? `${live.lut.replace(".cube", "").replaceAll("_", " ")} color grade` : undefined,
        keepBackground,
        background: keepBackground ? undefined : background.trim() || undefined,
      });
      setPack({ loading: null, pack: result, error: null });
    } catch (e) {
      setPack({ loading: null, pack: null, error: (e as Error).message });
    }
  }, [clip, casts, prompt, level, live.lut, keepBackground, background, ensureDepth]);

  const onGenerate = useCallback(() => {
    void generate();
  }, [generate]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      // studio shortcuts only on the studio, never under an open sheet (G starts a paid render)
      const sheetOpen = !!document.querySelector('[role=dialog], .sheet-backdrop, .library');
      if (e.key !== "Escape" && tabRef.current !== "studio" && tabRef.current !== "how") return;
      if ((e.code === "Space" || e.key === "g" || e.key === "G") && (tabRef.current !== "studio" || sheetOpen || t.tagName === "BUTTON")) return;
      if (e.code === "Space") {
        e.preventDefault();
        monitor.current?.togglePlay();
      } else if (e.key === "[") swapLens(-1);
      else if (e.key === "]") swapLens(1);
      else if (e.key === "g" || e.key === "G") onGenerate();
      else if (e.key === "f" || e.key === "F") setTab((x) => (x === "how" ? "studio" : "how"));
      else if (e.key === "d" || e.key === "D") setShowDepth((x) => !x);
      else if (e.key === "Escape") {
        setSharing(null);
        setPack(null);
        setRenderId(null);
        setGenerationError(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onGenerate, swapLens]);

  const uploadClip = async (f: File) => {
    try {
      setUploadPct(0);
      const c = await api.upload(f, setUploadPct);
      setClips((cs) => [c, ...cs]);
      setClipId(c.id);
      setRenderId(null);
      setGenerationError(null);
    } catch (e) {
      say((e as Error).message);
    } finally {
      setUploadPct(null);
    }
  };
  // A TikTok / Instagram / X link: the server downloads it and it becomes the video.
  const addVideoLink = async (url: string) => {
    const src = linkSource(url);
    if (!src) {
      say("Paste a TikTok, Instagram or X video link");
      return false;
    }
    try {
      setUploadPct(1);
      say(`Downloading from ${src.name}…`);
      const c = await api.uploadLink(src.url);
      setClips((cs) => [c, ...cs]);
      setClipId(c.id);
      setRenderId(null);
      setGenerationError(null);
      say(`${src.name} video added`);
      return true;
    } catch (e) {
      say((e as Error).message);
      return false;
    } finally {
      setUploadPct(null);
    }
  };
  const pickImage = (card: CastCard, only: "add" | "toggle" = "toggle") =>
    setCasts((cs) => {
      if (cs.some((c) => c.id === card.id)) return only === "add" ? cs : cs.filter((c) => c.id !== card.id);
      if (cs.filter((c) => c.kind === "character").length >= 4 && card.kind === "character") {
        say("Up to 4 characters");
        return cs;
      }
      return [...cs, card].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "character" ? -1 : 1));
    });

  const libraryUpload = async (files: File[], saveAsCharacter: boolean) => {
    for (const f of files) {
      if (f.type.startsWith("video/")) await uploadClip(f);
      else if (f.type.startsWith("image/")) {
        try {
          const c = await api.cast({ file: f, kind: "character", saved: saveAsCharacter }, setUploadPct);
          setImages((xs) => [c, ...xs]);
          if (libraryFor === "image") pickImage(c, "add");
        } catch (e) {
          say((e as Error).message);
        } finally {
          setUploadPct(null);
        }
      }
    }
  };

  // Paste an image (or video) from the clipboard anywhere: it goes to the
  // library, and on Create / the characters library it is picked as a character.
  // The character maker handles its own paste while it is open.
  const pasteRef = useRef<(e: ClipboardEvent) => void>(() => {});
  pasteRef.current = (e: ClipboardEvent) => {
    if (makerOpen) return;
    const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/") || f.type.startsWith("video/"));
    if (!files.length) {
      // a pasted TikTok / Reels / X link becomes the input video; other text goes to the text field
      const link = findVideoLink(e.clipboardData?.getData("text") ?? "");
      if (!link) return;
      e.preventDefault();
      void addVideoLink(link);
      return;
    }
    e.preventDefault();
    void (async () => {
      for (const raw of files) {
        // clipboard images are often all called "image.png": give them a useful name
        const f = raw.name && raw.name !== "image.png" ? raw : new File([raw], `Pasted ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.${raw.type.split("/")[1] || "png"}`, { type: raw.type });
        if (f.type.startsWith("video/")) {
          await uploadClip(f);
          continue;
        }
        try {
          const c = await api.cast({ file: f, kind: "character" }, setUploadPct);
          setImages((xs) => [c, ...xs]);
          if (level === "easy" || libraryFor === "image") {
            pickImage(c, "add");
            say("Pasted image added to your characters");
          } else say("Pasted image added to your library");
        } catch (err) {
          say((err as Error).message);
        } finally {
          setUploadPct(null);
        }
      }
    })();
  };
  useEffect(() => {
    const on = (e: ClipboardEvent) => pasteRef.current(e);
    window.addEventListener("paste", on);
    return () => window.removeEventListener("paste", on);
  }, []);

  const onDropItem = (item: DragItem) => {
    if (item.type === "clip") {
      setClipId(item.id);
      setRenderId(null);
      setGenerationError(null);
    } else {
      const card = images.find((i) => i.id === item.id);
      if (card) pickImage(card, "add");
    }
  };

  const addCast = async (input: { prompt?: string; file?: File; kind: CastCard["kind"] }) => {
    try {
      const c = await api.cast(input);
      setImages((xs) => [c, ...xs]);
      // characters first, then places: this is the @image numbering
      setCasts((cs) => [...cs, c].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "character" ? -1 : 1)));
    } catch (e) {
      say((e as Error).message);
    }
  };

  const engineLabel = useMemo(() => {
    if (!health) return "Connecting";
    // no ComfyUI of your own: workflows and partner models run on Comfy Cloud when a key is set
    if (health.engine === "preview") return health.preparation.comfyConfigured ? "Comfy Cloud" : "Preview mode";
    return "My ComfyUI";
  }, [health]);

  // Comfy API credits in the header while the API switch is on: every minute, and again when a job ends
  const apiOn = !!health && health.engine !== "comfy" && health.preparation.comfyConfigured;
  const [credits, setCredits] = useState<{ available: number; prepaid: number; pending: number } | null>(null);
  useEffect(() => {
    if (!apiOn) return setCredits(null);
    const load = () => void api.credits().then(setCredits).catch(() => setCredits(null));
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [apiOn]);
  useEffect(() => {
    if (apiOn && !queueActive) void api.credits(true).then(setCredits).catch(() => {});
  }, [apiOn, queueActive]);

  const keep = (t: Tab, el: ReactNode) => (seen.has(t) ? <div style={{ display: tab === t ? "contents" : "none" }}>{el}</div> : null);

  return (
    <div className="app">
      <header className="nav">
        <button className="brand" aria-label="MOGFIELD home" onClick={() => { setTab("studio"); setMenuOpen(false); setQueueOpen(false); }}>
          <span className="brand-mark" aria-hidden />
          <span className="brand-name">MOGFIELD</span>
        </button>
        <nav className="nav-links">
          {MENU.map((m) => (
            <button key={m.tab} className={tab === m.tab || (m.tab === "studio" && tab === "how") ? "on" : ""} onClick={() => setTab(m.tab)}>
              {m.label}
              {m.tab === "agent" && <sup className="exp-tag">Beta</sup>}
            </button>
          ))}
        </nav>
        <div className="nav-right">
          <div className="mode-switch" role="group" aria-label="Where workflows run" title={`${health?.target ?? "Comfy Cloud"} · change where it runs`}>
            <button className={health?.engine !== "comfy" ? "on" : ""} onClick={() => setBackendOpen("cloud")}>
              <i className={health?.engine !== "comfy" && health?.preparation.comfyConfigured ? "ok" : ""} />API
            </button>
            <button className={health?.engine === "comfy" ? "on" : ""} onClick={() => setBackendOpen("custom")}>
              <i className={health?.engine === "comfy" ? "ok" : ""} />LOCAL
            </button>
          </div>
          {apiOn && credits && (
            <a
              className={`credits-pill ${credits.available < 2 ? "low" : ""}`}
              href="https://platform.comfy.org/profile/billing"
              target="_blank"
              rel="noreferrer"
              title={`Comfy API credits: $${credits.prepaid.toFixed(2)} prepaid${credits.pending ? `, $${credits.pending.toFixed(2)} still being charged` : ""}. Click to top up.`}
            >
              ${credits.available.toFixed(2)}
            </a>
          )}
          <a className="btn ghost" href={`https://${health?.repo ?? "github.com"}`} target="_blank" rel="noreferrer">
            GitHub
          </a>
          {readyTake?.url && (
            <span className="ready-pill" role="status">
              <a href={readyTake.url} download={`mogfield-video-${readyTake.take}.mp4`} {...saveToPhotos(readyTake.url, `mogfield-video-${readyTake.take}.mp4`)} title={`Download video ${readyTake.take}`}>
                <svg viewBox="0 0 24 24" aria-hidden><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></svg>
                <span>Video {readyTake.take} ready · Download</span>
              </a>
              <button onClick={() => setReadyTake(null)} aria-label="Dismiss">×</button>
            </span>
          )}
          <QueueButton count={queueCount(queue)} busy={queueActive} open={queueOpen} onClick={() => { setQueueOpen((o) => !o); setMenuOpen(false); }} />
          <button className="accent nav-share" disabled={!render || render.status !== "succeeded"} onClick={() => render && setSharing(render)}>
            Share
          </button>
          <button className="burger" aria-label="Menu" aria-expanded={menuOpen} onClick={() => { setMenuOpen((o) => !o); setQueueOpen(false); }}>
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              {menuOpen ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
            </svg>
          </button>
        </div>
        {menuOpen && (
          <div className="burger-menu" role="menu" onClick={() => setMenuOpen(false)}>
            <button role="menuitem" onClick={() => setMakerOpen(true)}>Make a character</button>
            <button role="menuitem" disabled={!render || render.status !== "succeeded"} onClick={() => render && setSharing(render)}>Share</button>
            <a role="menuitem" href={`https://${health?.repo ?? "github.com"}`} target="_blank" rel="noreferrer">GitHub</a>
            <span className="burger-status">
              <i className={`dot ${health?.engine ?? ""}`} /> {engineLabel}
            </span>
          </div>
        )}
        {queueOpen && (
          <div className="queue-panel" role="dialog" aria-label="Queue">
            <div className="queue-panel-head">
              <b>Queue</b>
              <button className="ghost" onClick={() => { setTab("library"); setQueueOpen(false); }}>Open Library</button>
            </div>
            <QueueList items={queue} clips={clips} onOpen={openQueueItem} onDismiss={dismissQueueItem} empty="Nothing running. Preparations and takes show up here." />
          </div>
        )}
      </header>

      {(tab === "video" || tab === "studio" || tab === "how" || tab === "characters") && (
        <nav className="subnav" aria-label={tab === "video" ? "Video options" : tab === "characters" ? "Image options" : "Character Swap options"}>
          {tab === "characters"
            ? ([["image", "Create Image"], ["character", "Create Character"]] as const).map(([k, label]) => (
                <button key={k} className={imageSub === k ? "on" : ""} aria-current={imageSub === k ? "page" : undefined} onClick={() => goImage(k)}>{label}</button>
              ))
            : tab === "video"
            ? VIDEO_OPTIONS.map((o) => {
                const on = videoSub === o.sub && (o.sub !== "edit" || videoTool === o.tool);
                return (
                  <button key={o.label} className={on ? "on" : ""} aria-current={on ? "page" : undefined} onClick={() => goVideo(o.sub, o.tool)}>{o.label}</button>
                );
              })
            : (["easy", "pro"] as const).map((l) => (
                <button key={l} className={level === l ? "on" : ""} aria-current={level === l ? "page" : undefined} onClick={() => setLevel(l)}>{l === "easy" ? "Easy" : "Pro"}</button>
              ))}
        </nav>
      )}

      {keep("characters", (
        <div style={{ display: imageSub === "image" ? "contents" : "none" }}>
          <ImagePage
            images={images}
            apiMode={health?.engine !== "comfy"}
            say={say}
            onNewImage={(card) => setImages((xs) => [card, ...xs.filter((x) => x.id !== card.id)])}
            onMakeCharacter={() => goImage("character")}
          />
        </div>
      ))}
      {keep("characters", (
        <div style={{ display: imageSub === "character" ? "contents" : "none" }}>
        <CharacterStudio
          images={images}
          say={say}
          onNewCards={(cards) => setImages((xs) => [...cards, ...xs.filter((x) => !cards.some((c) => c.id === x.id))])}
          onUse={(card) => {
            pickImage(card, "add");
            setTab("studio");
            setLevel("easy");
            say(`${card.prompt} added to your characters. Add a video and Generate.`);
          }}
        />
        </div>
      ))}
      {keep("video", (
        <div style={{ display: videoSub === "restyle" ? "contents" : "none" }}>
        <RestylePage
          clip={clip}
          trim={trim}
          onTrim={setTrim}
          onPickVideo={() => setLibraryFor("video")}
          images={images}
          onNewImage={(card) => setImages((xs) => [card, ...xs.filter((x) => x.id !== card.id)])}
          models={models}
          renders={renders}
          clips={clips}
          say={say}
          onStart={startRestyle}
        />
        </div>
      ))}
      {keep("video", (
        <div style={{ display: videoSub === "restyle" ? "none" : "contents" }}>
        <VideoPage
          sub={videoSub}
          tool={videoTool}
          onNav={goVideo}
          images={images}
          onNewImage={(card) => setImages((xs) => [card, ...xs.filter((x) => x.id !== card.id)])}
          models={models}
          apiMode={health?.engine !== "comfy"}
          clip={clip}
          trim={trim}
          onPickVideo={() => setLibraryFor("video")}
          clips={clips}
          renders={renders}
          say={say}
          onReshoot={startReshoot}
        />
        </div>
      ))}
      {keep("agent", <AgentPage images={images} say={say} />)}
      {keep("library", (
        <LibraryPage
          queue={queue}
          clips={clips}
          preparations={preparations}
          renders={renders}
          onOpenQueueItem={openQueueItem}
          onDismiss={dismissQueueItem}
          onUseTemplate={applyTemplate}
          onOpenRender={(r) => openQueueItem({ kind: "render", at: r.createdAt, render: r })}
          onOpenUploads={() => setLibraryFor("video")}
        />
      ))}
      <div style={{ display: tab === "studio" || tab === "how" ? "contents" : "none" }}>
      <div className="workspace">
        {level === "easy" ? (
          <EasyPanel
            clip={clip}
            renderPreview={render?.url ? { url: render.url, label: render.isDraft ? "Generated draft" : "Generated video" } : null}
            onUploadClip={uploadClip}
            onVideoLink={addVideoLink}
            characters={casts.filter((c) => c.kind === "character")}
            onAddCharacter={(f) => addCast({ file: f, kind: "character" })}
            onRemoveCharacter={(id) => setCasts((cs) => cs.filter((c) => c.id !== id))}
            models={models}
            model={model}
            setModel={setModel}
            quality={quality}
            setQuality={setQuality}
            lora={lora}
            setLora={setLora}
            useDepth={useDepth}
            setUseDepth={setUseDepth}
            busy={busy}
            developing={developing}
            steps={developingSteps}
            generationError={generationError ?? (render?.status === "failed" ? render.error ?? render.message : null)}
            onGenerate={onGenerate}
            onOpenLibrary={setLibraryFor}
            onDropItem={onDropItem}
            trim={trim}
            onTrim={setTrim}
            uploadPct={uploadPct}
            prompt={prompt}
            setPrompt={setPrompt}
            promptOn={easyPromptOn}
            setPromptOn={setEasyPromptOn}
            keepBackground={keepBackground}
            setKeepBackground={setKeepBackground}
            background={background}
            setBackground={setBackground}
            maxSeconds={maxSeconds}
            costLabel={costLabel}
          />
        ) : (
          <ControlPanel
            mode={mode}
            setMode={setMode}
            clip={clip}
            renderPreview={render?.url ? { url: render.url, label: render.isDraft ? "Generated draft" : "Generated video" } : null}
            onUploadClip={uploadClip}
            onVideoLink={addVideoLink}
            onReplaceVideo={() => setLibraryFor("video")}
            trim={trim}
            onTrim={setTrim}
            keepBackground={keepBackground}
            setKeepBackground={setKeepBackground}
            background={background}
            setBackground={setBackground}
            maxSeconds={maxSeconds}
            level={level}
            setLevel={setLevel}
            models={models}
            model={model}
            setModel={setModel}
            quality={quality}
            setQuality={setQuality}
            lora={lora}
            setLora={setLora}
            useDepth={useDepth}
            setUseDepth={setUseDepth}
            costLabel={costLabel}
            onPromptOnly={() => void makePack()}
            casts={casts}
            onRemoveCast={(id) => setCasts((cs) => cs.filter((c) => c.id !== id))}
            onAddCast={addCast}
            engine={health?.engine ?? "preview"}
            prompt={prompt}
            setPrompt={setPrompt}
            dir={dir}
            set={set}
            luts={luts}
            busy={busy || !!pack?.loading}
            developing={developing}
            steps={developingSteps}
            generationError={generationError}
            onGenerate={onGenerate}
            depthJob={clip ? depthJobs[clip.id] ?? null : null}
            showDepth={showDepth}
            onToggleDepth={() => setShowDepth((x) => !x)}
            onGenerateDepth={() => void generateDepth()}
            failedRender={render?.status === "failed" ? render : null}
          />
        )}

        <main className="main-card">
          <div className="main-tabs">
            <button className={tab === "studio" ? "on" : ""} onClick={() => setTab("studio")}>
              Preview
            </button>
            <button className={tab === "how" ? "on" : ""} onClick={() => setTab("how")}>
              Workflow
            </button>
            <span className="kbd-hints">
              <kbd>G</kbd> generate <kbd>[</kbd><kbd>]</kbd> lens <kbd>D</kbd> depth <kbd>Space</kbd> play
            </span>
          </div>

          {tab === "studio" ? (
            <div className="studio-scroll">
              <section className="hero">
                <div className="hero-copy">
                  {view === "reveal" && render ? (
                    <>
                      {render.isDraft ? (
                        <>
                          <h1>Your draft is ready.</h1>
                          <p>Review the 480p preview, then render a 1080p final with additional Comfy credits.</p>
                        </>
                      ) : (
                        <>
                          <h1>Your video is ready.</h1>
                          <p>Drag across the video to compare the original with the result.</p>
                        </>
                      )}
                      <div className="hero-actions">
                        {render.isDraft ? (
                          <button className="accent" disabled={busy} onClick={() => void finalizeDraft(render)}>
                            {busy ? "Working…" : `Render final · 1080p${finalCostLabel ? ` · ${finalCostLabel}` : ""}`}
                          </button>
                        ) : (
                          <button className="accent" onClick={() => setSharing(render)}>Share</button>
                        )}
                        <button onClick={() => { setRenderId(null); setGenerationError(null); }}>Back to editing</button>
                      </div>
                    </>
                  ) : (
                    <>
                      {level === "easy" ? (
                        <>
                          <h1>Turn one video into many.</h1>
                          <p>Keep the motion, swap the people. Add a video and your characters. MOGFIELD maps the depth, writes the prompt and renders it.</p>
                        </>
                      ) : (
                        <>
                          <h1>
                            One video.
                            <br />
                            Every shot.
                          </h1>
                          <p>
                            {mode === "recast"
                              ? "Keep the motion and swap the characters and places with your own references."
                              : "Add a real camera move, lens and color to any phone video. Changes preview instantly."}
                          </p>
                          <ul className="hero-facts">
                            <li><span>Camera</span><b>{mode === "recast" ? "From your video" : live.camera === "static" ? "Off" : PRESET_LABEL[live.camera]}</b></li>
                            <li><span>Lens</span><b>{dir.on.lens ? `${live.lens} · f/${live.fStop}` : "Off"}</b></li>
                            <li><span>Color</span><b>{live.lut === "none" ? "Off" : live.lut.replace(".cube", "").replaceAll("_", " ")}</b></li>
                          </ul>
                        </>
                      )}
                    </>
                  )}
                </div>
                <div className="hero-monitor">
                  <Monitor
                    ref={monitor}
                    clip={view === "reveal" ? revealClip : clip}
                    dir={render && view === "reveal" ? { ...dir, ...render.params, rackFocus: render.params.focusEnd >= 0 } : live}
                    render={render}
                    view={view}
                    developing={developing}
                    depthUrl={view === "live" && level === "pro" ? clip?.depthUrl : undefined}
                    showDepth={showDepth}
                    onToggleDepth={() => setShowDepth((x) => !x)}
                  />
                </div>
              </section>

              <Gallery
                clips={clips}
                renders={renders}
                activeClip={clipId}
                activeRender={renderId}
                onClip={(id) => {
                  setClipId(id);
                  setRenderId(null);
                  setGenerationError(null);
                }}
                onRender={(id) => {
                  const r = renders.find((x) => x.id === id);
                  if (r) setClipId(r.params.clipId);
                  setRenderId(id);
                  setGenerationError(null);
                }}
              />
            </div>
          ) : (
            <div className="how">
              {/* opens on the workflow behind what you have picked */}
              <GraphView name={level === "pro" ? (mode === "recast" ? "backlot_recast" : "backlot_direct") : model.startsWith("h3:") ? "backlot_h3_swap" : "mogfield_seedance_restyle"} />
            </div>
          )}
        </main>
      </div>
      </div>

      {sharing && <ShareSheet render={sharing} repo={health?.repo ?? "github.com/Trenchplanet/mogfield"} onClose={() => setSharing(null)} />}
      {backendOpen && (
        <BackendSheet
          initial={backendOpen}
          onClose={() => setBackendOpen(false)}
          onChanged={() => {
            void api.health().then(setHealth).catch(() => {});
            void api.models().then(setModels).catch(() => {});
          }}
        />
      )}
      {preparationOpen && clip && <PreparationSheet
        clip={clip}
        trim={requestTrim}
        preparation={activePreparation}
        readiness={health?.preparation ?? { comfyConfigured: false, rubberBandConfigured: false }}
        costLabel={costLabel}
        onPreparation={setPreparation}
        onApproved={setPreparation}
        onGenerate={onGenerate}
        onClose={() => setPreparationOpen(false)}
      />}
      {libraryFor && (
        <Library
          target={libraryFor}
          clips={clips.filter((c) => !c.sample)}
          images={images}
          renders={renders}
          selectedClip={clipId}
          selectedImages={casts.map((c) => c.id)}
          onPickClip={(id) => {
            setClipId(id);
            setRenderId(null);
            setGenerationError(null);
            setLibraryFor(null);
          }}
          onToggleImage={(card) => pickImage(card)}
          onUpload={libraryUpload}
          onVideoLink={async (url) => {
            const ok = await addVideoLink(url);
            if (ok) setLibraryFor(null);
            return ok;
          }}
          onSave={(id, saved) =>
            void api.updateImage(id, { saved }).then((c) => {
              setImages((xs) => xs.map((x) => (x.id === id ? c : x)));
              setCasts((xs) => xs.map((x) => (x.id === id ? c : x)));
            }).catch((e) => say((e as Error).message))
          }
          onDelete={(id) =>
            confirm("Delete this image? This can't be undone.") &&
            void api.deleteImage(id).then(() => {
              setImages((xs) => xs.filter((x) => x.id !== id));
              setCasts((xs) => xs.filter((x) => x.id !== id));
            }).catch((e) => say((e as Error).message))
          }
          onOpenRender={(id) => {
            const r = renders.find((x) => x.id === id);
            if (r) setClipId(r.params.clipId);
            setRenderId(id);
            setGenerationError(null);
            setLibraryFor(null);
          }}
          onClose={() => setLibraryFor(null)}
          onMakeCharacter={() => setMakerOpen(true)}
          uploadPct={uploadPct}
        />
      )}
      {makerOpen && (
        <CharacterMaker
          onClose={() => setMakerOpen(false)}
          onCreated={(c) => setImages((xs) => [c, ...xs.filter((x) => x.id !== c.id)])}
          onUse={(c) => {
            pickImage(c, "add");
            setMakerOpen(false);
            setLibraryFor(null);
          }}
        />
      )}
      {pack && <PackSheet state={pack} onClose={() => setPack(null)} />}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
