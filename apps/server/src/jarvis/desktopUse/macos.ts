import type {
  DesktopUseAction,
  DesktopUseModifier,
  DesktopUseMouseButton,
} from "@t3tools/contracts";

const imports =
  'ObjC.import("CoreGraphics"); ObjC.import("AppKit"); ObjC.import("ApplicationServices");';
export const macScript = (body: string) => ({
  command: "/usr/bin/osascript",
  args: ["-l", "JavaScript", "-e", `${imports}\n${body}`],
});

export const macDisplays = () =>
  macScript(`
var screens=$.NSScreen.screens, out=[];
var height=screens.objectAtIndex(0).frame.size.height;
for(var i=0;i<screens.count;i++) {
  var s=screens.objectAtIndex(i), f=s.frame;
  out.push({id:String(ObjC.unwrap(s.deviceDescription.objectForKey("NSScreenNumber"))), x:f.origin.x,y:height-f.origin.y-f.size.height,width:f.size.width,height:f.size.height,scale:s.backingScaleFactor,primary:i===0});
}
JSON.stringify(out);
`);

export const macReadiness = () =>
  macScript(
    "JSON.stringify({capture:Boolean($.CGPreflightScreenCaptureAccess()),input:Boolean($.AXIsProcessTrusted())});",
  );
export const macCursor = () =>
  macScript(
    'var event=$.CGEventCreate(null); var p=$.CGEventGetLocation(event); $.CFRelease(event); String(p.x)+","+String(p.y);',
  );

export const macWindows = () =>
  macScript(`
var se=Application("System Events"),out=[];
se.processes.whose({visible:true})().forEach(function(p){
  p.windows().forEach(function(w){
    var xy=w.position(),size=w.size(),title=w.name();
    if(title) out.push({id:JSON.stringify({pid:p.unixId(),title:title,x:xy[0],y:xy[1]}),title:title,appName:p.name(),x:xy[0],y:xy[1],width:size[0],height:size[1],active:p.frontmost()});
  });
});
JSON.stringify(out);
`);

export const macFocus = (windowId: string) =>
  macScript(`
var target=JSON.parse(${JSON.stringify(windowId)}),se=Application("System Events");
var processes=se.processes.whose({unixId:target.pid})();
if(processes.length!==1) throw new Error("Window process is no longer available");
var p=processes[0],matches=p.windows().filter(function(w){var xy=w.position();return w.name()===target.title&&xy[0]===target.x&&xy[1]===target.y;});
if(matches.length!==1) throw new Error("Window changed or is ambiguous; list windows again");
p.frontmost=true;
matches[0].actions.byName("AXRaise").perform();
`);

const buttonIndex = (button: DesktopUseMouseButton = "left") =>
  button === "left" ? 0 : button === "right" ? 1 : 2;
export function macPointer(action: {
  type: string;
  x?: number | undefined;
  y?: number | undefined;
  button?: DesktopUseMouseButton | undefined;
  count?: number | undefined;
  deltaX?: number | undefined;
  deltaY?: number | undefined;
  dragging?: boolean | undefined;
}) {
  const button = buttonIndex(action.button);
  const down = [1, 3, 25][button]!,
    up = [2, 4, 26][button]!,
    drag = [6, 7, 27][button]!;
  return macScript(`
if(!$.AXIsProcessTrusted()) throw new Error("Accessibility permission is required");
var initial=$.CGEventCreate(null),position=$.CGEventGetLocation(initial);$.CFRelease(initial);
var x=${action.x === undefined ? "position.x" : Math.round(action.x)},y=${action.y === undefined ? "position.y" : Math.round(action.y)};
function post(type,count){var event=$.CGEventCreateMouseEvent(null,type,$.CGPointMake(x,y),${button});if(!event)throw new Error("Cannot create pointer event");try{if(count)$.CGEventSetIntegerValueField(event,1,count);$.CGEventPost(0,event);}finally{$.CFRelease(event);}}
${action.x === undefined || action.type === "pointer.move" ? "" : "post(5);"}
${action.type === "pointer.move" ? `post(${action.dragging ? drag : 5});` : ""}
${action.type === "pointer.down" ? `post(${down});` : ""}
${action.type === "pointer.up" ? `post(${up});` : ""}
${action.type === "pointer.click" ? `for(var i=1;i<=${action.count ?? 1};i++){try{post(${down},i);}finally{post(${up},i);}delay(0.08);}` : ""}
${action.type === "pointer.scroll" ? `var event=$.CGEventCreateScrollWheelEvent2(null,1,2,${-(action.deltaY ?? 0)},${-(action.deltaX ?? 0)},0);try{$.CGEventPost(0,event);}finally{$.CFRelease(event);}` : ""}
`);
}

const APPLESCRIPT_MODIFIERS: Record<DesktopUseModifier, string> = {
  alt: "option down",
  control: "control down",
  meta: "command down",
  shift: "shift down",
};
export const MAC_KEYS: Readonly<Record<string, number>> = {
  enter: 36,
  return: 36,
  tab: 48,
  space: 49,
  delete: 117,
  del: 117,
  backspace: 51,
  escape: 53,
  esc: 53,
  left: 123,
  arrowleft: 123,
  right: 124,
  arrowright: 124,
  down: 125,
  arrowdown: 125,
  up: 126,
  arrowup: 126,
  home: 115,
  end: 119,
  pageup: 116,
  pagedown: 121,
  insert: 114,
  capslock: 57,
  shift: 56,
  control: 59,
  ctrl: 59,
  alt: 58,
  meta: 55,
  super: 55,
  win: 55,
  f1: 122,
  f2: 120,
  f3: 99,
  f4: 118,
  f5: 96,
  f6: 97,
  f7: 98,
  f8: 100,
  f9: 101,
  f10: 109,
  f11: 103,
  f12: 111,
};
const appleString = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

export function macKeyboard(
  action: Extract<DesktopUseAction, { type: "keyboard.key" | "keyboard.type" }>,
) {
  if (action.type === "keyboard.key") {
    const code = MAC_KEYS[action.key.toLowerCase()];
    const using = (action.modifiers ?? []).map((m) => APPLESCRIPT_MODIFIERS[m]).join(", ");
    return {
      command: "/usr/bin/osascript",
      args: [
        "-e",
        `tell application "System Events" to ${code === undefined ? `keystroke ${appleString(action.key)}` : `key code ${code}`}${using ? ` using {${using}}` : ""}`,
      ],
    };
  }
  return macScript(`
if(!$.AXIsProcessTrusted()) throw new Error("Accessibility permission is required");
ObjC.bindFunction("CGEventKeyboardSetUnicodeString",["void",["void *","unsigned long","void *"]]);
var text=${JSON.stringify(action.text)};
for(var i=0;i<text.length;){
  var end=Math.min(i+20,text.length);
  if(end<text.length && text.charCodeAt(end-1)>=0xD800 && text.charCodeAt(end-1)<=0xDBFF) end--;
  var chunk=text.slice(i,end);i=end;
  var data=$.NSString.stringWithString(chunk).dataUsingEncoding($.NSUTF16LittleEndianStringEncoding);
  var down=$.CGEventCreateKeyboardEvent(null,0,true),up=$.CGEventCreateKeyboardEvent(null,0,false);
  try{$.CGEventKeyboardSetUnicodeString(down,chunk.length,data.bytes);$.CGEventKeyboardSetUnicodeString(up,chunk.length,data.bytes);$.CGEventPost(0,down);}
  finally{$.CGEventPost(0,up);$.CFRelease(down);$.CFRelease(up);}
}
`);
}

export const macReleaseKeys = (keys: ReadonlyArray<number>) =>
  macScript(`
${JSON.stringify(keys)}.forEach(function(code){var event=$.CGEventCreateKeyboardEvent(null,code,false);try{$.CGEventPost(0,event);}finally{$.CFRelease(event);}});
`);

export const macDrag = (action: Extract<DesktopUseAction, { type: "pointer.drag" }>) => {
  const button = buttonIndex(action.button),
    down = [1, 3, 25][button]!,
    up = [2, 4, 26][button]!,
    drag = [6, 7, 27][button]!;
  const duration = action.durationMs ?? 250,
    steps = Math.max(1, Math.min(120, Math.ceil(duration / 16)));
  return macScript(`
if(!$.AXIsProcessTrusted()) throw new Error("Accessibility permission is required");
var x=${action.from.x},y=${action.from.y};
function post(type){var event=$.CGEventCreateMouseEvent(null,type,$.CGPointMake(x,y),${button});if(!event)throw new Error("Cannot create pointer event");try{$.CGEventPost(0,event);}finally{$.CFRelease(event);}}
post(5);
try {
  post(${down});
  for(var i=1;i<=${steps};i++) {
    delay(${duration / steps / 1000});
    x=${action.from.x}+(${action.to.x - action.from.x})*i/${steps};
    y=${action.from.y}+(${action.to.y - action.from.y})*i/${steps};
    post(${drag});
  }
} finally { post(${up}); }
`);
};
