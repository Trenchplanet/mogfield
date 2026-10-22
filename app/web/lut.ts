// .cube parsing shared by the WebGL monitor and the swatch thumbnails.
// Same file the GradeLUT node reads, so the live preview matches the render.

export interface Lut {
  size: number;
  data: Float32Array; // r fastest, then g, then b; RGB triplets
  domainMin: number;
  domainMax: number;
}

export function parseCube(text: string): Lut {
  let size = 0;
  let dmin = 0;
  let dmax = 1;
  const vals: number[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line[0] === "#") continue;
    const parts = line.split(/\s+/);
    const key = parts[0].toUpperCase();
    if (key === "LUT_3D_SIZE") size = Number(parts[1]);
    else if (key === "DOMAIN_MIN") dmin = Number(parts[1]);
    else if (key === "DOMAIN_MAX") dmax = Number(parts[1]);
    else if (parts.length === 3 && !Number.isNaN(Number(parts[0]))) vals.push(+parts[0], +parts[1], +parts[2]);
  }
  if (!size || vals.length !== size ** 3 * 3) throw new Error("invalid .cube");
  return { size, data: new Float32Array(vals), domainMin: dmin, domainMax: dmax };
}

const cache = new Map<string, Promise<Lut>>();
export function loadLut(name: string): Promise<Lut> {
  if (!cache.has(name)) cache.set(name, fetch(`/luts/${encodeURIComponent(name)}`).then((r) => r.text()).then(parseCube));
  return cache.get(name)!;
}

/** Trilinear CPU lookup, used for swatch thumbnails. */
export function applyLutPixel(l: Lut, r: number, g: number, b: number): [number, number, number] {
  const s = l.size - 1;
  const n = (v: number) => Math.min(1, Math.max(0, (v - l.domainMin) / (l.domainMax - l.domainMin))) * s;
  const [x, y, z] = [n(r), n(g), n(b)];
  const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
  const x1 = Math.min(s, x0 + 1), y1 = Math.min(s, y0 + 1), z1 = Math.min(s, z0 + 1);
  const fx = x - x0, fy = y - y0, fz = z - z0;
  const at = (i: number, j: number, k: number, c: number) => l.data[((k * l.size + j) * l.size + i) * 3 + c];
  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const c00 = at(x0, y0, z0, c) * (1 - fx) + at(x1, y0, z0, c) * fx;
    const c10 = at(x0, y1, z0, c) * (1 - fx) + at(x1, y1, z0, c) * fx;
    const c01 = at(x0, y0, z1, c) * (1 - fx) + at(x1, y0, z1, c) * fx;
    const c11 = at(x0, y1, z1, c) * (1 - fx) + at(x1, y1, z1, c) * fx;
    out[c] = (c00 * (1 - fy) + c10 * fy) * (1 - fz) + (c01 * (1 - fy) + c11 * fy) * fz;
  }
  return out;
}

export function lutLabel(file: string) {
  return file.replace(/\.cube$/i, "").replaceAll("_", " ");
}
