import { safeInlineJson } from "./inline-json.ts";

export type CompanionWebglLifecycle = Readonly<{
  readonly setActive: (active: boolean) => void;
  readonly setVisible: (visible: boolean) => void;
  readonly setReducedMotion: (reduced: boolean) => void;
  readonly restart: () => void;
  readonly dispose: () => void;
}>;

export const COMPANION_WEBGL_BURST_FRAMES = 45;
export const COMPANION_WEBGL_BURST_MS = 1_500;
/** Keep the shader below 30fps while it is settling; idle surfaces never draw. */
export const COMPANION_WEBGL_FRAME_INTERVAL_MS = 33;

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

const vertexShader = `attribute vec2 position;void main(){gl_Position=vec4(position,0.0,1.0);}`;
const fragmentShader = `precision mediump float;uniform float time;uniform vec2 resolution;void main(){vec2 p=(gl_FragCoord.xy-.5*resolution)/min(resolution.x,resolution.y);float r=length(p);float wave=sin(7.0*r-time*1.7+sin(p.x*4.0+time)*.35);float glow=smoothstep(.76,.08,r);vec3 deep=vec3(.035,.16,.19);vec3 light=vec3(.35,.82,.78);vec3 color=mix(deep,light,.5+.5*wave)*glow;gl_FragColor=vec4(color,glow*.68);}`;

/** Generates the renderer-only shader seam without importing browser globals in main. */
export function companionWebglScript(surface: "voice" | "setup"): string {
  if (surface !== "voice") return "";
  return `<script>(()=>{const mount=document.querySelector('.voice-presence');if(!mount||!window.WebGLRenderingContext)return;const canvas=document.createElement('canvas');canvas.className='voice-field';canvas.setAttribute('aria-hidden','true');mount.prepend(canvas);const activeStates=new Set(['listening','transcribing','working','speaking']);const reduced=window.matchMedia('(prefers-reduced-motion: reduce)');const burstFramesLimit=${COMPANION_WEBGL_BURST_FRAMES};const burstMsLimit=${COMPANION_WEBGL_BURST_MS};const frameInterval=${COMPANION_WEBGL_FRAME_INTERVAL_MS};let gl;let program;let timeLocation;let resolutionLocation;let positionLocation;let frame;let active=false;let burstFrames=0;let burstStartedAt=0;let lastFrame=0;let previousState='idle';let previousVisibility=document.visibilityState==='visible';let previousReduced=reduced.matches;const vertex=${safeInlineJson(vertexShader)};const fragment=${safeInlineJson(fragmentShader)};const stop=()=>{if(frame!==undefined){cancelAnimationFrame(frame);frame=undefined}};const resize=()=>{if(!gl)return;const dpr=Math.min(window.devicePixelRatio||1,1.5);canvas.width=Math.max(1,Math.floor(canvas.clientWidth*dpr));canvas.height=Math.max(1,Math.floor(canvas.clientHeight*dpr));gl.viewport(0,0,canvas.width,canvas.height)};const compile=(type,source)=>{const shader=gl.createShader(type);if(!shader)return;gl.shaderSource(shader,source);gl.compileShader(shader);if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS)){gl.deleteShader(shader);return}return shader};const setup=()=>{gl=canvas.getContext('webgl',{alpha:true,antialias:false,preserveDrawingBuffer:false});if(!gl){canvas.hidden=true;return false}const vs=compile(gl.VERTEX_SHADER,vertex);const fs=compile(gl.FRAGMENT_SHADER,fragment);if(!vs||!fs){canvas.hidden=true;return false}program=gl.createProgram();if(!program)return false;gl.attachShader(program,vs);gl.attachShader(program,fs);gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS)){canvas.hidden=true;return false}positionLocation=gl.getAttribLocation(program,'position');timeLocation=gl.getUniformLocation(program,'time');resolutionLocation=gl.getUniformLocation(program,'resolution');const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),gl.STATIC_DRAW);gl.enableVertexAttribArray(positionLocation);gl.vertexAttribPointer(positionLocation,2,gl.FLOAT,false,0,0);resize();return true};const beginBurst=()=>{stop();if(!active||reduced.matches||document.visibilityState!=='visible')return;burstFrames=0;burstStartedAt=0;lastFrame=0;frame=requestAnimationFrame(draw)};const draw=now=>{frame=undefined;if(!active||document.visibilityState!=='visible'||reduced.matches)return;burstStartedAt=burstStartedAt||now;if(burstFrames>=burstFramesLimit||now-burstStartedAt>=burstMsLimit)return;if(now-lastFrame<frameInterval){frame=requestAnimationFrame(draw);return}if(!gl||!program)return;lastFrame=now;resize();gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);gl.useProgram(program);gl.uniform1f(timeLocation,now/1000);gl.uniform2f(resolutionLocation,canvas.width,canvas.height);gl.drawArrays(gl.TRIANGLE_STRIP,0,4);burstFrames+=1;frame=requestAnimationFrame(draw)};const update=(contextRestored=false)=>{const nextState=document.body.dataset.presentationState||'idle';const nextActive=activeStates.has(nextState);const stateChanged=nextState!==previousState;const visibleNow=document.visibilityState==='visible';const visibilityChanged=visibleNow!==previousVisibility;const reducedNow=reduced.matches;const reducedChanged=reducedNow!==previousReduced;active=nextActive;previousState=nextState;previousVisibility=visibleNow;previousReduced=reducedNow;if(active&&!reducedNow&&visibleNow){canvas.hidden=false;if(contextRestored||stateChanged||visibilityChanged||reducedChanged)beginBurst()}else{stop();canvas.hidden=true}};if(!setup())return;canvas.addEventListener('webglcontextlost',event=>{event.preventDefault();stop();canvas.hidden=true});canvas.addEventListener('webglcontextrestored',()=>{if(setup())update(true)});new ResizeObserver(resize).observe(canvas);new MutationObserver(()=>update()).observe(document.body,{attributes:true,attributeFilter:['data-presentation-state']});document.addEventListener('visibilitychange',()=>update());reduced.addEventListener('change',()=>update());window.addEventListener('beforeunload',stop);update(true)})()</script>`;
}
