// WebGL2 live monitor: video -> camera move preview -> focal crop -> 3D LUT ->
// halation -> vignette -> grain. No GPU round trip, so grade and lens changes
// are instant; only Recast and the depth-driven passes wait for a render.

import type { Lut } from "./lut";

const VERT = `#version 300 es
in vec2 p;
out vec2 uv;
void main() { uv = p * 0.5 + 0.5; uv.y = 1.0 - uv.y; gl_Position = vec4(p, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 uv;
out vec4 o;
uniform sampler2D src;
uniform sampler3D lut;
uniform float lutMix, lutOn, zoom, vignette, grain, halation, time, aspect;
uniform vec2 pan, texel;
uniform float lutScale, lutOffset, depthMode;

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233)) + time * 37.0) * 43758.5453); }

vec3 grade(vec3 c) {
  if (lutOn < 0.5) return c;
  vec3 g = texture(lut, clamp(c, 0.0, 1.0) * lutScale + lutOffset).rgb;
  return mix(c, g, lutMix);
}

// Turbo colormap (Mikhailov 2019, polynomial fit): near = warm, far = cool
vec3 turbo(float x) {
  x = clamp(x, 0.0, 1.0);
  vec4 v4 = vec4(1.0, x, x * x, x * x * x);
  vec2 v2 = v4.zw * v4.z;
  return vec3(
    dot(v4, vec4(0.13572138, 4.61539260, -42.66032258, 132.13108234)) + dot(v2, vec2(-152.94239396, 59.28637943)),
    dot(v4, vec4(0.09140261, 2.19418839, 4.84296658, -14.18503333)) + dot(v2, vec2(4.27729857, 2.82956604)),
    dot(v4, vec4(0.10667330, 12.64194608, -60.58204836, 110.36276771)) + dot(v2, vec2(-89.90310912, 27.34824973)));
}

void main() {
  vec2 q = (uv - 0.5) / zoom + 0.5 + pan;
  vec3 c = texture(src, clamp(q, 0.0, 1.0)).rgb;
  if (depthMode > 0.5) {
    float d = c.r;
    o = vec4(depthMode > 1.5 ? vec3(d) : turbo(d), 1.0);
    return;
  }
  if (halation > 0.0) {
    vec3 glow = vec3(0.0);
    for (int i = 0; i < 12; i++) {
      float a = float(i) * 0.5236;
      for (int r = 1; r <= 2; r++) {
        vec2 off = vec2(cos(a), sin(a)) * texel * 9.0 * float(r) / zoom;
        float l = luma(texture(src, clamp(q + off, 0.0, 1.0)).rgb);
        glow += vec3(1.0, 0.28, 0.12) * clamp((l - 0.72) / 0.28, 0.0, 1.0);
      }
    }
    glow /= 24.0;
    c = 1.0 - (1.0 - c) * (1.0 - glow * halation);
  }
  c = grade(c);
  vec2 v = (uv - 0.5) * vec2(1.0, 1.0);
  float r2 = clamp(dot(v, v) * 2.0, 0.0, 1.0);
  c *= 1.0 - vignette * pow(r2, 1.5);
  float L = luma(c);
  c += (hash(uv * 1000.0) - 0.5) * 2.0 * grain * 4.0 * L * (1.0 - L);
  o = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

export interface MonitorUniforms {
  zoom: number;
  pan: [number, number];
  lutMix: number;
  vignette: number;
  grain: number;
  halation: number;
  /** 0 = picture, 1 = depth (turbo colormap), 2 = depth (grey) */
  depthMode?: number;
}

export class MonitorGL {
  private gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private srcTex: WebGLTexture;
  private lutTex: WebGLTexture;
  private lutOn = false;
  private lutScale = 1;
  private lutOffset = 0;
  private loc: Record<string, WebGLUniformLocation | null> = {};

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", { premultipliedAlpha: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error("WebGL2 unavailable");
    this.gl = gl;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? "link");
    this.prog = prog;
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const p = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(p);
    gl.vertexAttribPointer(p, 2, gl.FLOAT, false, 0, 0);
    for (const n of ["depthMode", "src", "lut", "lutMix", "lutOn", "zoom", "pan", "vignette", "grain", "halation", "time", "texel", "lutScale", "lutOffset", "aspect"])
      this.loc[n] = gl.getUniformLocation(prog, n);

    this.srcTex = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.lutTex = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, this.lutTex);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE]])
      gl.texParameteri(gl.TEXTURE_3D, k, v);
    gl.uniform1i(this.loc.src, 0);
    gl.uniform1i(this.loc.lut, 1);
  }

  setLut(l: Lut | null) {
    const gl = this.gl;
    this.lutOn = !!l;
    if (!l) return;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, this.lutTex);
    // .cube is r-fastest, which is exactly WebGL's x-fastest 3D layout
    const rgba = new Float32Array(l.size ** 3 * 4);
    for (let i = 0; i < l.size ** 3; i++) {
      rgba[i * 4] = l.data[i * 3];
      rgba[i * 4 + 1] = l.data[i * 3 + 1];
      rgba[i * 4 + 2] = l.data[i * 3 + 2];
      rgba[i * 4 + 3] = 1;
    }
    const half = gl.getExtension("OES_texture_float_linear") ? null : true;
    if (half) {
      const u8 = new Uint8Array(rgba.length);
      for (let i = 0; i < rgba.length; i++) u8[i] = Math.round(Math.min(1, Math.max(0, rgba[i])) * 255);
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, l.size, l.size, l.size, 0, gl.RGBA, gl.UNSIGNED_BYTE, u8);
    } else {
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA32F, l.size, l.size, l.size, 0, gl.RGBA, gl.FLOAT, rgba);
    }
    // sample texel centres so 0 and 1 hit the first and last entries
    this.lutScale = (l.size - 1) / l.size;
    this.lutOffset = 0.5 / l.size;
  }

  draw(source: TexImageSource | null, u: MonitorUniforms, time: number) {
    const gl = this.gl;
    const c = this.canvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(c.clientWidth * dpr);
    const h = Math.round(c.clientHeight * dpr);
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.prog);
    if (source) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, source);
      } catch {
        return; // frame not ready yet
      }
    }
    gl.uniform1f(this.loc.depthMode, u.depthMode ?? 0);
    gl.uniform1f(this.loc.lutMix, u.lutMix);
    gl.uniform1f(this.loc.lutOn, this.lutOn ? 1 : 0);
    gl.uniform1f(this.loc.lutScale, this.lutScale);
    gl.uniform1f(this.loc.lutOffset, this.lutOffset);
    gl.uniform1f(this.loc.zoom, u.zoom);
    gl.uniform2f(this.loc.pan, u.pan[0], u.pan[1]);
    gl.uniform1f(this.loc.vignette, u.vignette);
    gl.uniform1f(this.loc.grain, u.grain);
    gl.uniform1f(this.loc.halation, u.halation);
    gl.uniform1f(this.loc.time, time % 100);
    gl.uniform1f(this.loc.aspect, w / h);
    gl.uniform2f(this.loc.texel, 1 / Math.max(1, w), 1 / Math.max(1, h));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}
