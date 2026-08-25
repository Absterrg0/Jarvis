/** The visual states shared by Jarvis-owned surfaces. */
export const JARVIS_PRESENCE_MODES = [
  "idle",
  "listening",
  "working",
  "speaking",
  "attention",
  "error",
] as const;

export type JarvisPresenceMode = (typeof JARVIS_PRESENCE_MODES)[number];

/** Semantic colors are deliberately restrained; surfaces may tint them, but should not invent state colors. */
export const JARVIS_PRESENCE_PALETTE: Readonly<
  Record<JarvisPresenceMode, readonly [number, number, number]>
> = {
  idle: [0.2, 0.68, 0.66],
  listening: [0.2, 0.84, 0.82],
  working: [0.5, 0.56, 0.86],
  speaking: [0.55, 0.78, 0.52],
  attention: [1.0, 0.62, 0.27],
  error: [0.82, 0.32, 0.29],
};

export const JARVIS_PRESENCE_SHADER_MOTION = {
  frameIntervalMs: 33,
  maxFrames: 45,
  burstDurationMs: 1_500,
} as const;

/** A fullscreen triangle keeps the renderer tiny and avoids geometry churn between surfaces. */
export const JARVIS_PRESENCE_VERTEX_SHADER = `
attribute vec2 a_position;
varying vec2 v_uv;
void main(){
  v_uv=a_position*.5+.5;
  gl_Position=vec4(a_position,0.0,1.0);
}`;

/** Restrained acoustic ribbons: fluid signal, no orb/glitter or continuously moving particles. */
export const JARVIS_PRESENCE_FRAGMENT_SHADER = `
precision mediump float;
uniform float u_time;
uniform float u_progress;
uniform vec2 u_resolution;
uniform vec3 u_color;
varying vec2 v_uv;
void main(){
  vec2 p=(gl_FragCoord.xy-.5*u_resolution)/min(u_resolution.x,u_resolution.y);
  float t=u_time*.78;
  float ribbonCenter=.035*sin(p.x*5.4+t)+.018*sin(p.x*12.0-t*1.25);
  float ribbon=1.0-smoothstep(.018,.085,abs(p.y-ribbonCenter));
  float echoCenter=-.16+.03*sin(p.x*4.0+t*1.3);
  float echo=1.0-smoothstep(.012,.095,abs(p.y-echoCenter));
  float envelope=1.0-smoothstep(.18,.62,length(p*vec2(.82,1.28)));
  float edge=1.0-smoothstep(.24,.55,abs(p.x));
  float energy=(ribbon*.76+echo*.18)*(0.52+u_progress*.48)*envelope*edge;
  vec3 color=u_color*(.72+ribbon*.28);
  gl_FragColor=vec4(color,energy*.78);
}`;

export interface JarvisPresenceFrameScheduler {
  readonly requestFrame: (callback: (timestamp: number) => void) => number;
  readonly cancelFrame: (frame: number) => void;
}

export interface JarvisPresenceLifecycle {
  readonly setMode: (mode: JarvisPresenceMode) => void;
  readonly setVisible: (visible: boolean) => void;
  readonly setReducedMotion: (reducedMotion: boolean) => void;
  readonly restart: () => void;
  readonly dispose: () => void;
}

export function createJarvisPresenceLifecycle(input: {
  readonly requestFrame: JarvisPresenceFrameScheduler["requestFrame"];
  readonly cancelFrame: JarvisPresenceFrameScheduler["cancelFrame"];
  readonly draw: (timestamp: number) => void;
  readonly visible: boolean;
  readonly reducedMotion: boolean;
  readonly now?: () => number;
  readonly frameIntervalMs?: number;
  readonly maxFrames?: number;
  readonly burstDurationMs?: number;
}): JarvisPresenceLifecycle {
  let mode: JarvisPresenceMode = "idle";
  let visible = input.visible;
  let reducedMotion = input.reducedMotion;
  let frame: number | undefined;
  let running = false;
  let frameCount = 0;
  let startedAt: number | undefined;
  let lastDrawAt = Number.NEGATIVE_INFINITY;

  const frameIntervalMs = input.frameIntervalMs ?? JARVIS_PRESENCE_SHADER_MOTION.frameIntervalMs;
  const maxFrames = input.maxFrames ?? JARVIS_PRESENCE_SHADER_MOTION.maxFrames;
  const burstDurationMs = input.burstDurationMs ?? JARVIS_PRESENCE_SHADER_MOTION.burstDurationMs;

  const stop = () => {
    running = false;
    if (frame !== undefined) {
      input.cancelFrame(frame);
      frame = undefined;
    }
  };

  const schedule = () => {
    if (!running || frame !== undefined) return;
    frame = input.requestFrame((timestamp) => {
      frame = undefined;
      if (!running || !visible || reducedMotion || mode === "idle") return;
      const currentTime = input.now?.() ?? timestamp;
      startedAt ??= currentTime;
      if (frameCount >= maxFrames || currentTime - startedAt >= burstDurationMs) {
        running = false;
        return;
      }
      if (currentTime - lastDrawAt < frameIntervalMs) {
        schedule();
        return;
      }
      lastDrawAt = currentTime;
      frameCount += 1;
      input.draw(timestamp);
      schedule();
    });
  };

  const beginBurst = () => {
    stop();
    if (!visible || reducedMotion || mode === "idle") return;
    frameCount = 0;
    startedAt = undefined;
    lastDrawAt = Number.NEGATIVE_INFINITY;
    running = true;
    schedule();
  };

  return {
    setMode(nextMode) {
      if (nextMode === mode) return;
      mode = nextMode;
      if (nextMode === "idle") stop();
      else beginBurst();
    },
    setVisible(nextVisible) {
      if (nextVisible === visible) return;
      visible = nextVisible;
      if (nextVisible) beginBurst();
      else stop();
    },
    setReducedMotion(nextReducedMotion) {
      if (nextReducedMotion === reducedMotion) return;
      reducedMotion = nextReducedMotion;
      if (nextReducedMotion) stop();
      else beginBurst();
    },
    restart: beginBurst,
    dispose: stop,
  };
}
