import {
  JARVIS_PRESENCE_FRAGMENT_SHADER,
  JARVIS_PRESENCE_PALETTE,
  JARVIS_PRESENCE_SHADER_MOTION,
  JARVIS_PRESENCE_VERTEX_SHADER,
  type JarvisPresenceMode,
} from "@t3tools/jarvis-client-runtime/presence";
import { safeInlineJson } from "./inline-json.ts";

export type CompanionWebglLifecycle = Readonly<{
  readonly setActive: (active: boolean) => void;
  readonly setVisible: (visible: boolean) => void;
  readonly setReducedMotion: (reduced: boolean) => void;
  readonly restart: () => void;
  readonly dispose: () => void;
}>;

export const COMPANION_WEBGL_BURST_FRAMES = JARVIS_PRESENCE_SHADER_MOTION.maxFrames;
export const COMPANION_WEBGL_BURST_MS = JARVIS_PRESENCE_SHADER_MOTION.burstDurationMs;
export const COMPANION_WEBGL_FRAME_INTERVAL_MS = JARVIS_PRESENCE_SHADER_MOTION.frameIntervalMs;

export function createCompanionWebglLifecycle(input: {
  readonly requestFrame: (callback: (timestamp: number) => void) => number;
  readonly cancelFrame: (frame: number) => void;
  readonly draw: (timestamp: number) => void;
  readonly reducedMotion: () => boolean;
  readonly visible: () => boolean;
}): CompanionWebglLifecycle {
  let active = false;
  let visible = input.visible();
  let reduced = input.reducedMotion();
  let frame: number | undefined;
  let burstFrames = 0;
  let burstStartedAt: number | undefined;
  let burstRunning = false;

  const stop = () => {
    burstRunning = false;
    if (frame === undefined) return;
    input.cancelFrame(frame);
    frame = undefined;
  };
  const beginBurst = () => {
    stop();
    if (!active || !visible || reduced) return;
    burstFrames = 0;
    burstStartedAt = undefined;
    burstRunning = true;
    schedule();
  };
  const schedule = () => {
    if (!active || !visible || reduced || !burstRunning || frame !== undefined) return;
    frame = input.requestFrame((timestamp) => {
      frame = undefined;
      if (!active || !visible || reduced) return;
      burstStartedAt ??= timestamp;
      if (
        burstFrames >= COMPANION_WEBGL_BURST_FRAMES ||
        timestamp - burstStartedAt >= COMPANION_WEBGL_BURST_MS
      ) {
        burstRunning = false;
        return;
      }
      input.draw(timestamp);
      burstFrames += 1;
      schedule();
    });
  };

  return {
    setActive(next) {
      if (next === active) return;
      active = next;
      if (next) beginBurst();
      else stop();
    },
    setVisible(next) {
      if (next === visible) return;
      visible = next;
      if (next) beginBurst();
      else stop();
    },
    setReducedMotion(next) {
      if (next === reduced) return;
      reduced = next;
      if (next) stop();
      else beginBurst();
    },
    restart: beginBurst,
    dispose: stop,
  };
}

const presenceColors = Object.fromEntries(
  Object.entries(JARVIS_PRESENCE_PALETTE).map(([mode, color]) => [mode, color]),
) as Record<JarvisPresenceMode, readonly [number, number, number]>;

/** Generates a renderer-only seam; setup deliberately has no animated field. */
export function companionWebglScript(surface: "voice" | "setup"): string {
  if (surface !== "voice") return "";
  return `<script>(()=>{const mount=document.querySelector('.voice-presence');if(!mount)return;if(!window.WebGLRenderingContext){mount.dataset.visualFallback='visible';return}const canvas=document.createElement('canvas');canvas.className='voice-field';canvas.setAttribute('aria-hidden','true');mount.prepend(canvas);const activeStates=new Set(['listening','transcribing','working','speaking']);const reduced=window.matchMedia('(prefers-reduced-motion: reduce)');const burstFramesLimit=${COMPANION_WEBGL_BURST_FRAMES};const burstMsLimit=${COMPANION_WEBGL_BURST_MS};const frameInterval=${COMPANION_WEBGL_FRAME_INTERVAL_MS};const colors=${safeInlineJson(presenceColors)};const vertex=${safeInlineJson(JARVIS_PRESENCE_VERTEX_SHADER)};const fragment=${safeInlineJson(JARVIS_PRESENCE_FRAGMENT_SHADER)};let gl;let program;let timeLocation;let progressLocation;let resolutionLocation;let colorLocation;let positionLocation;let frame;let active=false;let burstFrames=0;let burstStartedAt=0;let lastFrame=0;let previousState='idle';let previousVisibility=document.visibilityState==='visible';let previousReduced=reduced.matches;const setFallback=visible=>{mount.dataset.visualFallback=visible?'visible':'hidden'};const stop=()=>{if(frame!==undefined){cancelAnimationFrame(frame);frame=undefined}};const resize=()=>{if(!gl)return;const dpr=Math.min(window.devicePixelRatio||1,1.5);canvas.width=Math.max(1,Math.floor(canvas.clientWidth*dpr));canvas.height=Math.max(1,Math.floor(canvas.clientHeight*dpr));gl.viewport(0,0,canvas.width,canvas.height)};const compile=(type,source)=>{const shader=gl.createShader(type);if(!shader)return;gl.shaderSource(shader,source);gl.compileShader(shader);if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS)){gl.deleteShader(shader);return}return shader};const setup=()=>{gl=canvas.getContext('webgl',{alpha:true,antialias:false,preserveDrawingBuffer:false});if(!gl){canvas.hidden=true;setFallback(true);return false}const vs=compile(gl.VERTEX_SHADER,vertex);const fs=compile(gl.FRAGMENT_SHADER,fragment);if(!vs||!fs){canvas.hidden=true;setFallback(true);return false}program=gl.createProgram();if(!program){canvas.hidden=true;setFallback(true);return false}gl.attachShader(program,vs);gl.attachShader(program,fs);gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS)){canvas.hidden=true;setFallback(true);return false}positionLocation=gl.getAttribLocation(program,'a_position');timeLocation=gl.getUniformLocation(program,'u_time');progressLocation=gl.getUniformLocation(program,'u_progress');resolutionLocation=gl.getUniformLocation(program,'u_resolution');colorLocation=gl.getUniformLocation(program,'u_color');const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),gl.STATIC_DRAW);gl.enableVertexAttribArray(positionLocation);gl.vertexAttribPointer(positionLocation,2,gl.FLOAT,false,0,0);resize();return true};const modeForState=state=>state==='transcribing'?'listening':state;const beginBurst=()=>{stop();if(!active||reduced.matches||document.visibilityState!=='visible')return;burstFrames=0;burstStartedAt=0;lastFrame=0;frame=requestAnimationFrame(draw)};const draw=now=>{frame=undefined;if(!active||document.visibilityState!=='visible'||reduced.matches)return;burstStartedAt=burstStartedAt||now;if(burstFrames>=burstFramesLimit||now-burstStartedAt>=burstMsLimit)return;if(now-lastFrame<frameInterval){frame=requestAnimationFrame(draw);return}if(!gl||!program)return;lastFrame=now;resize();const rgb=colors[modeForState(document.body.dataset.presentationState||'idle')]||colors.idle;gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);gl.useProgram(program);gl.uniform1f(timeLocation,now/1000);gl.uniform1f(progressLocation,burstFrames/burstFramesLimit);gl.uniform2f(resolutionLocation,canvas.width,canvas.height);gl.uniform3f(colorLocation,rgb[0],rgb[1],rgb[2]);gl.drawArrays(gl.TRIANGLE_STRIP,0,4);burstFrames+=1;frame=requestAnimationFrame(draw)};const update=(contextRestored=false)=>{const nextState=document.body.dataset.presentationState||'idle';const nextActive=activeStates.has(nextState);const stateChanged=nextState!==previousState;const visibleNow=document.visibilityState==='visible';const visibilityChanged=visibleNow!==previousVisibility;const reducedNow=reduced.matches;const reducedChanged=reducedNow!==previousReduced;active=nextActive;previousState=nextState;previousVisibility=visibleNow;previousReduced=reducedNow;if(active&&!reducedNow&&visibleNow){canvas.hidden=false;setFallback(false);if(contextRestored||stateChanged||visibilityChanged||reducedChanged)beginBurst()}else{stop();canvas.hidden=true;setFallback(true)}};if(!setup())return;canvas.addEventListener('webglcontextlost',event=>{event.preventDefault();stop();canvas.hidden=true;setFallback(true)});canvas.addEventListener('webglcontextrestored',()=>{if(setup())update(true)});new ResizeObserver(resize).observe(canvas);new MutationObserver(()=>update()).observe(document.body,{attributes:true,attributeFilter:['data-presentation-state']});document.addEventListener('visibilitychange',()=>update());reduced.addEventListener('change',()=>update());window.addEventListener('beforeunload',stop);update(true)})()</script>`;
}
