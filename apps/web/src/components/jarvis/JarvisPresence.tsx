import { useEffect, useRef, useState } from "react";

import { startJarvisPresenceBurst, type JarvisPresenceMode } from "./JarvisPresence.logic";

const VERTEX_SHADER = `
  attribute vec2 a_position;
  varying vec2 v_uv;
  void main() {
    v_uv = a_position * 0.5 + 0.5;
    gl_Position = vec4(a_position, 0.0, 1.0);
  }
`;

const FRAGMENT_SHADER = `
  precision mediump float;
  uniform float u_time;
  uniform float u_progress;
  uniform vec3 u_color;
  varying vec2 v_uv;
  void main() {
    vec2 point = v_uv - 0.5;
    float distanceFromCenter = length(point * vec2(1.0, 1.08));
    float ringRadius = 0.23 + 0.05 * sin(u_progress * 3.14159265);
    float ring = 1.0 - smoothstep(0.01, 0.055, abs(distanceFromCenter - ringRadius));
    float glow = exp(-distanceFromCenter * 8.0) * (0.18 + 0.14 * u_progress);
    float shimmer = 0.94 + 0.06 * sin(u_time * 2.0 + point.x * 8.0);
    float alpha = min(0.82, (ring * 0.48 + glow) * shimmer);
    gl_FragColor = vec4(u_color * (0.6 + ring * 0.4), alpha);
  }
`;

const MODE_COLORS: Record<JarvisPresenceMode, readonly [number, number, number]> = {
  idle: [0.28, 0.72, 0.96],
  listening: [0.45, 0.75, 1.0],
  working: [0.58, 0.48, 1.0],
  speaking: [0.34, 0.92, 0.78],
  attention: [1.0, 0.76, 0.32],
  error: [1.0, 0.5, 0.32],
};

const MODE_LABELS: Record<JarvisPresenceMode, string> = {
  idle: "Ready",
  listening: "Listening",
  working: "Working",
  speaking: "Speaking",
  attention: "Needs input",
  error: "Needs attention",
};

interface WebGlRenderer {
  readonly draw: (progress: number, timestamp: number) => void;
  readonly dispose: () => void;
}

function compileShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (shader === null) throw new Error("Could not create Jarvis presence shader.");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) ?? "unknown shader error";
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}

function createWebGlRenderer(
  canvas: HTMLCanvasElement,
  color: readonly [number, number, number],
): WebGlRenderer | null {
  let cleanupGl: WebGLRenderingContext | null = null;
  let vertex: WebGLShader | null = null;
  let fragment: WebGLShader | null = null;
  let program: WebGLProgram | null = null;
  let buffer: WebGLBuffer | null = null;
  try {
    const context = canvas.getContext("webgl", { alpha: true, antialias: true });
    if (context === null) return null;
    const gl = context;
    cleanupGl = gl;
    vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    program = gl.createProgram();
    if (program === null) throw new Error("Could not create Jarvis presence program.");
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    vertex = null;
    fragment = null;
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) ?? "unknown program error");
    }
    const position = gl.getAttribLocation(program, "a_position");
    const time = gl.getUniformLocation(program, "u_time");
    const progress = gl.getUniformLocation(program, "u_progress");
    const uniformColor = gl.getUniformLocation(program, "u_color");
    buffer = gl.createBuffer();
    if (
      position < 0 ||
      time === null ||
      progress === null ||
      uniformColor === null ||
      buffer === null
    ) {
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      buffer = null;
      program = null;
      return null;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.useProgram(program);
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    return {
      draw: (value, timestamp) => {
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.useProgram(program);
        gl.uniform1f(time, timestamp / 1000);
        gl.uniform1f(progress, value);
        gl.uniform3fv(uniformColor, color);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      },
      dispose: () => {
        gl.deleteBuffer(buffer);
        gl.deleteProgram(program);
      },
    };
  } catch {
    if (cleanupGl !== null) {
      if (vertex !== null) cleanupGl.deleteShader(vertex);
      if (fragment !== null) cleanupGl.deleteShader(fragment);
      if (buffer !== null) cleanupGl.deleteBuffer(buffer);
      if (program !== null) cleanupGl.deleteProgram(program);
    }
    return null;
  }
}

function drawCanvasFallback(
  canvas: HTMLCanvasElement,
  mode: JarvisPresenceMode,
  progress: number,
): void {
  try {
    const context = canvas.getContext("2d");
    if (context === null) return;
    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;
    const radius = Math.min(centerX, centerY) * (0.4 + progress * 0.06);
    const [red, green, blue] = MODE_COLORS[mode].map((channel) => Math.round(channel * 255));
    context.clearRect(0, 0, canvas.width, canvas.height);
    const glow = context.createRadialGradient(centerX, centerY, 0, centerX, centerY, radius * 2.5);
    glow.addColorStop(0, `rgba(${red}, ${green}, ${blue}, 0.48)`);
    glow.addColorStop(1, `rgba(${red}, ${green}, ${blue}, 0)`);
    context.fillStyle = glow;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.beginPath();
    context.arc(centerX, centerY, radius, 0, Math.PI * 2);
    context.strokeStyle = `rgba(${red}, ${green}, ${blue}, 0.72)`;
    context.lineWidth = Math.max(1, canvas.width / 32);
    context.stroke();
  } catch {
    // The readable state label remains the fallback if canvas rendering is unavailable.
  }
}

function sizeCanvas(canvas: HTMLCanvasElement): void {
  const bounds = canvas.getBoundingClientRect();
  const scale = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(bounds.width * scale));
  const height = Math.max(1, Math.round(bounds.height * scale));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);
  return reduced;
}

export function JarvisPresence({
  mode,
  visible,
}: {
  readonly mode: JarvisPresenceMode;
  readonly visible: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    sizeCanvas(canvas);
    const color = MODE_COLORS[mode];
    let renderer = createWebGlRenderer(canvas, color);
    const draw = (progress: number, timestamp = performance.now()) => {
      if (renderer !== null) renderer.draw(progress, timestamp);
      else drawCanvasFallback(canvas, mode, progress);
    };
    draw(1);
    const onContextLost = (event: Event) => {
      event.preventDefault();
      renderer?.dispose();
      renderer = null;
      draw(1);
    };
    const onContextRestored = () => {
      renderer = createWebGlRenderer(canvas, color);
      draw(1);
    };
    canvas.addEventListener("webglcontextlost", onContextLost);
    canvas.addEventListener("webglcontextrestored", onContextRestored);
    const stop = startJarvisPresenceBurst({
      mode,
      visible,
      reducedMotion,
      scheduler: { request: requestAnimationFrame, cancel: cancelAnimationFrame },
      onProgress: (progress) => draw(progress),
    });
    return () => {
      stop();
      renderer?.dispose();
      renderer = null;
      canvas.removeEventListener("webglcontextlost", onContextLost);
      canvas.removeEventListener("webglcontextrestored", onContextRestored);
    };
  }, [mode, reducedMotion, visible]);

  return (
    <div
      className="flex min-w-[10rem] items-center gap-2 rounded-xl border border-info/15 bg-info/5 px-2 py-1"
      aria-live="polite"
    >
      <canvas
        ref={canvasRef}
        width={40}
        height={40}
        aria-hidden="true"
        className="size-11 shrink-0 rounded-full shadow-sm shadow-info/10"
      />
      <div className="min-w-0">
        <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground">
          Jarvis presence
        </p>
        <p className="truncate text-xs font-medium">{MODE_LABELS[mode]}</p>
      </div>
    </div>
  );
}
