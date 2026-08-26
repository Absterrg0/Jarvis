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

/**
 * A compact fluid field of warped luminous ribbons. Gaps stay transparent on
 * purpose so the companion never collapses into a radial filled blob at icon
 * size — the eye should read moving strands, not a soft circle.
 */
export const JARVIS_PRESENCE_FRAGMENT_SHADER = `
precision mediump float;
uniform float u_time;
uniform float u_progress;
uniform vec2 u_resolution;
uniform vec3 u_color;
varying vec2 v_uv;

float hash(vec2 p){
  return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);
}

float noise(vec2 p){
  vec2 i=floor(p);
  vec2 f=fract(p);
  f=f*f*(3.0-2.0*f);
  return mix(mix(hash(i),hash(i+vec2(1.0,0.0)),f.x),mix(hash(i+vec2(0.0,1.0)),hash(i+vec2(1.0)),f.x),f.y);
}

float fbm(vec2 p){
  float value=0.0;
  float weight=0.5;
  for(int i=0;i<4;i++){
    value+=weight*noise(p);
    p=mat2(1.6,1.2,-1.2,1.6)*p+0.21;
    weight*=0.5;
  }
  return value;
}

float strand(vec2 p, float center, float width){
  float distanceToCenter=abs(p.y-center);
  float glow=1.0-smoothstep(width*1.6,width*5.4,distanceToCenter);
  float ink=1.0-smoothstep(width*.55,width*1.55,distanceToCenter);
  return glow*.55+ink*1.05;
}

void main(){
  // Scale by height so the same ribbons keep their proportions on a wide
  // overlay and on the square companion icon.
  vec2 p=(gl_FragCoord.xy-.5*u_resolution)/u_resolution.y;
  float t=u_time*(1.05+u_progress*.35);
  float flowNoise=fbm(vec2(p.x*2.8+t*.22,p.y*2.4-t*.16))-.5;
  float bend=sin(p.x*3.4+t*1.45)*.16;
  bend+=sin(p.x*7.8-t*1.05)*.055;
  bend+=flowNoise*.11;

  // Three separate centerlines make the animation legible at icon scale.
  float upperCenter=bend+.22+sin(p.x*2.4-t*.9)*.05;
  float middleCenter=bend*.62+sin(p.x*5.8+t*.95)*.04;
  float lowerCenter=-bend*.9-.22+sin(p.x*3.1+t*.7)*.06;
  float width=.034+.008*sin(t*1.55+p.x*2.0);
  float upper=strand(p,upperCenter,width*1.12);
  float middle=strand(p,middleCenter,width*.9);
  float lower=strand(p,lowerCenter,width*1.28);
  float ribbons=clamp(upper+middle+lower,0.0,1.0);
  float highlight=clamp(
    pow(upper,1.65)*.95+pow(middle,1.65)*.8+pow(lower,1.65)*1.15,
    0.0,
    1.0
  );
  float hueShift=.5+.5*sin(p.x*4.2-t*.95+flowNoise*4.0);
  vec3 secondary=mix(vec3(.18,.86,1.0),vec3(.62,.38,1.0),hueShift);
  vec3 ink=mix(u_color,secondary,.5+.16*sin(t*1.2+p.x*2.6));
  vec3 color=ink*(.28+ribbons*.95);
  color+=vec3(.78,.98,1.0)*highlight*.95;
  color+=secondary*flowNoise*.12;

  // Keep the canvas transparent between strands; this is intentionally not a
  // circular mask or full-surface haze.
  float alpha=clamp(ribbons*.92+highlight*.28,0.0,.98);
  // Soft rectangular falloff only — never a radial disc mask.
  float edge=smoothstep(.0,.12,v_uv.x)*smoothstep(1.0,.88,v_uv.x)*smoothstep(.0,.14,v_uv.y)*smoothstep(1.0,.86,v_uv.y);
  gl_FragColor=vec4(color,alpha*edge);
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
  readonly draw: (progress: number, timestamp: number) => void;
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
      const progress = Math.min(1, Math.max(0, (currentTime - startedAt) / burstDurationMs));
      input.draw(progress, timestamp);
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
