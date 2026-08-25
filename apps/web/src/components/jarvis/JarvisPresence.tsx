import { useEffect, useRef, useState } from "react";

import {
  createJarvisPresenceLifecycle,
  JARVIS_PRESENCE_FRAGMENT_SHADER,
  JARVIS_PRESENCE_PALETTE,
  JARVIS_PRESENCE_VERTEX_SHADER,
  type JarvisPresenceMode,
} from "@t3tools/jarvis-client-runtime/presence";
export { JARVIS_PRESENCE_PALETTE } from "@t3tools/jarvis-client-runtime/presence";
export type { JarvisPresenceMode } from "@t3tools/jarvis-client-runtime/presence";

/** Stable state palette shared by WebGL, canvas, and CSS fallbacks. */
const MODE_COLORS = JARVIS_PRESENCE_PALETTE;

export const JARVIS_PRESENCE_MODE_LABELS: Readonly<Record<JarvisPresenceMode, string>> = {
  idle: "Standby",
  listening: "Listening",
  working: "In progress",
  speaking: "Speaking",
  attention: "Attention",
  error: "Error",
};

const MODE_LABELS = JARVIS_PRESENCE_MODE_LABELS;

interface WebGlRenderer {
  readonly draw: (
    progress: number,
    timestamp: number,
    color: readonly [number, number, number],
  ) => void;
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

function createWebGlRenderer(canvas: HTMLCanvasElement): WebGlRenderer | null {
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
    vertex = compileShader(gl, gl.VERTEX_SHADER, JARVIS_PRESENCE_VERTEX_SHADER);
    fragment = compileShader(gl, gl.FRAGMENT_SHADER, JARVIS_PRESENCE_FRAGMENT_SHADER);
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
    const resolution = gl.getUniformLocation(program, "u_resolution");
    const uniformColor = gl.getUniformLocation(program, "u_color");
    buffer = gl.createBuffer();
    if (
      position < 0 ||
      time === null ||
      progress === null ||
      resolution === null ||
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
      draw: (value, timestamp, color) => {
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.useProgram(program);
        gl.uniform1f(time, timestamp / 1000);
        gl.uniform1f(progress, value);
        gl.uniform2f(resolution, canvas.width, canvas.height);
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
    const centerY = canvas.height / 2;
    const [red, green, blue] = MODE_COLORS[mode].map((channel) => Math.round(channel * 255));
    context.clearRect(0, 0, canvas.width, canvas.height);
    const amplitude = canvas.height * (0.06 + progress * 0.025);
    context.beginPath();
    context.moveTo(canvas.width * 0.08, centerY);
    context.bezierCurveTo(
      canvas.width * 0.28,
      centerY - amplitude,
      canvas.width * 0.4,
      centerY + amplitude,
      canvas.width * 0.58,
      centerY,
    );
    context.bezierCurveTo(
      canvas.width * 0.72,
      centerY - amplitude * 0.8,
      canvas.width * 0.84,
      centerY + amplitude * 0.65,
      canvas.width * 0.92,
      centerY,
    );
    context.strokeStyle = `rgba(${red}, ${green}, ${blue}, 0.76)`;
    context.lineWidth = Math.max(1, canvas.width / 28);
    context.lineCap = "round";
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
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const lifecycleRef = useRef<ReturnType<typeof createJarvisPresenceLifecycle> | null>(null);
  const reducedMotion = useReducedMotion();
  const [canvasFallback, setCanvasFallback] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    sizeCanvas(canvas);
    let renderer = createWebGlRenderer(canvas);
    setCanvasFallback(renderer === null);
    const draw = (progress: number, timestamp = performance.now()) => {
      const currentMode = modeRef.current;
      if (renderer !== null) renderer.draw(progress, timestamp, MODE_COLORS[currentMode]);
      else drawCanvasFallback(canvas, currentMode, progress);
    };
    draw(1);
    const onContextLost = (event: Event) => {
      event.preventDefault();
      renderer?.dispose();
      renderer = null;
      setCanvasFallback(true);
      draw(1);
    };
    const onContextRestored = () => {
      renderer = createWebGlRenderer(canvas);
      setCanvasFallback(renderer === null);
      draw(1);
    };
    canvas.addEventListener("webglcontextlost", onContextLost);
    canvas.addEventListener("webglcontextrestored", onContextRestored);
    const resizeObserver = new ResizeObserver(() => {
      sizeCanvas(canvas);
      draw(1);
    });
    resizeObserver.observe(canvas);
    const lifecycle = createJarvisPresenceLifecycle({
      requestFrame: requestAnimationFrame,
      cancelFrame: cancelAnimationFrame,
      draw,
      visible,
      reducedMotion,
    });
    lifecycleRef.current = lifecycle;
    lifecycle.setMode(modeRef.current);
    return () => {
      lifecycle.dispose();
      lifecycleRef.current = null;
      renderer?.dispose();
      renderer = null;
      resizeObserver.disconnect();
      canvas.removeEventListener("webglcontextlost", onContextLost);
      canvas.removeEventListener("webglcontextrestored", onContextRestored);
    };
  }, [reducedMotion, visible]);

  useEffect(() => {
    lifecycleRef.current?.setMode(mode);
  }, [mode]);

  return (
    <div
      className="relative flex min-w-[11rem] items-center gap-2.5 rounded-lg border border-border/70 bg-muted/10 px-2.5 py-1.5"
      aria-live="polite"
    >
      <span
        data-presence-fallback
        aria-hidden="true"
        className={`pointer-events-none absolute left-3 top-1/2 h-px w-[4.5rem] -translate-y-1/2 -rotate-2 rounded-full bg-info/70 shadow-[0_0_10px_rgb(35_211_198/0.38)] transition-opacity ${canvasFallback ? "opacity-90" : "opacity-0"}`}
      />
      <canvas
        ref={canvasRef}
        width={72}
        height={28}
        aria-hidden="true"
        className="relative z-10 h-7 w-[4.5rem] shrink-0 rounded-md border border-info/15 bg-black/20"
      />
      <div className="min-w-0">
        <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground">
          Presence
        </p>
        <p className="truncate text-xs font-medium">{MODE_LABELS[mode]}</p>
      </div>
    </div>
  );
}
