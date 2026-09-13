import type {
  DesktopUseAction,
  DesktopUseDisplay,
  DesktopUseMouseButton,
} from "@t3tools/contracts";

/** Each PowerShell invocation owns its DPI context and releases anything it presses. */
const native = String.raw`
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class DesktopInput {
  [StructLayout(LayoutKind.Sequential)] public struct Mouse { public int x,y; public uint data,flags,time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] public struct Key { public ushort vk,scan; public uint flags,time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] public struct Union { [FieldOffset(0)] public Mouse mouse; [FieldOffset(0)] public Key key; }
  [StructLayout(LayoutKind.Sequential)] public struct Input { public uint type; public Union data; }
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, Input[] inputs, int size);
  [DllImport("user32.dll", SetLastError=true)] static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, IntPtr process);
  [DllImport("user32.dll")] static extern IntPtr GetKeyboardLayout(uint thread);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern short VkKeyScanEx(char ch, IntPtr layout);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window,int command);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int left,top,right,bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window,out Rect rect);
  static void Emit(Input input) {
    if (SendInput(1,new Input[]{input},Marshal.SizeOf(typeof(Input))) != 1) throw new Win32Exception(Marshal.GetLastWin32Error(),"Input injection was refused");
  }
  public static void Move(int x,int y) { if(!SetCursorPos(x,y)) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  public static void Button(int button,bool down) {
    uint[] downs={0x0002,0x0008,0x0020}; uint[] ups={0x0004,0x0010,0x0040};
    var input=new Input();input.data.mouse.flags=down?downs[button]:ups[button];Emit(input);
  }
  public static void Wheel(int horizontal,int vertical) {
    if(vertical!=0){var input=new Input();input.data.mouse.flags=0x0800;input.data.mouse.data=unchecked((uint)(-vertical*120));Emit(input);}
    if(horizontal!=0){var input=new Input();input.data.mouse.flags=0x1000;input.data.mouse.data=unchecked((uint)(horizontal*120));Emit(input);}
  }
  static void KeyEvent(ushort vk,ushort scan,uint flags) { var input=new Input();input.type=1;input.data.key.vk=vk;input.data.key.scan=scan;input.data.key.flags=flags|((vk>=33&&vk<=40||vk==45||vk==46||vk==91||vk==92)?1u:0u);Emit(input); }
  public static void Text(string text) {
    foreach(char ch in text) { try { KeyEvent(0,ch,4); } finally { KeyEvent(0,ch,6); } }
  }
  public static void ReleaseText(string text) {
    foreach(char ch in new System.Collections.Generic.HashSet<char>(text)) KeyEvent(0,ch,6);
  }
  public static void ReleaseCharacter(char ch,ushort[] modifiers) {
    var layout=GetKeyboardLayout(GetWindowThreadProcessId(GetForegroundWindow(),IntPtr.Zero));
    short mapped=VkKeyScanEx(ch,layout);
    if(mapped==-1) return;
    ReleaseKey((ushort)(mapped&255));
    ushort[] maskKeys={0x10,0x11,0x12};
    for(int i=0;i<3;i++) if(((mapped>>8)&(1<<i))!=0) ReleaseKey(maskKeys[i]);
    foreach(ushort modifier in modifiers) ReleaseKey(modifier);
  }
  public static void ReleaseKey(ushort code) { KeyEvent(code,0,2); }
  public static void Press(ushort code,ushort[] modifiers) {
    try { foreach(ushort modifier in modifiers) KeyEvent(modifier,0,0); KeyEvent(code,0,0); }
    finally { KeyEvent(code,0,2); for(int i=modifiers.Length-1;i>=0;i--) KeyEvent(modifiers[i],0,2); }
  }
  public static void Character(char ch,ushort[] modifiers) {
    var layout=GetKeyboardLayout(GetWindowThreadProcessId(GetForegroundWindow(),IntPtr.Zero));
    short mapped=VkKeyScanEx(ch,layout);
    if(mapped==-1) throw new ArgumentException("Character has no shortcut key in the active keyboard layout; use desktop_type for text");
    var mods=new System.Collections.Generic.List<ushort>(modifiers);
    ushort[] maskKeys={0x10,0x11,0x12};
    for(int i=0;i<3;i++) if(((mapped>>8)&(1<<i))!=0&&!mods.Contains(maskKeys[i])) mods.Add(maskKeys[i]);
    Press((ushort)(mapped&255),mods.ToArray());
  }
}
`;

const psString = (value: string) => `'${value.replaceAll("'", "''")}'`;

export function windowsScript(body: string): string {
  return [
    "$ErrorActionPreference='Stop'",
    "Add-Type -TypeDefinition @'",
    native,
    "'@",
    "if ([DesktopInput]::SetThreadDpiAwarenessContext([IntPtr](-4)) -eq [IntPtr]::Zero) { throw 'Cannot establish the physical-pixel DPI context' }",
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    body,
  ].join("\n");
}

export function captureWindowsScript(outPath: string, display?: DesktopUseDisplay): string {
  const bounds = display
    ? `$bounds=New-Object System.Drawing.Rectangle ${display.x},${display.y},${display.width},${display.height}`
    : "$bounds=[System.Windows.Forms.SystemInformation]::VirtualScreen";
  return windowsScript(
    [
      bounds,
      "$bmp=New-Object System.Drawing.Bitmap $bounds.Width,$bounds.Height",
      "$gfx=[System.Drawing.Graphics]::FromImage($bmp)",
      `try { $gfx.CopyFromScreen($bounds.X,$bounds.Y,0,0,$bmp.Size); $bmp.Save(${psString(outPath)},[System.Drawing.Imaging.ImageFormat]::Png) } finally { $gfx.Dispose(); $bmp.Dispose() }`,
    ].join("\n"),
  );
}

export const displaysWindowsScript = () =>
  windowsScript(
    "ConvertTo-Json -Compress -InputObject @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object { [pscustomobject]@{ id=$_.DeviceName; scale=1; primary=$_.Primary; x=$_.Bounds.X; y=$_.Bounds.Y; width=$_.Bounds.Width; height=$_.Bounds.Height } })",
  );
export const cursorWindowsScript = () =>
  windowsScript('$p=[System.Windows.Forms.Cursor]::Position; Write-Output "$($p.X),$($p.Y)"');
export const windowsListScript = () =>
  windowsScript(String.raw`
@(
  Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and [DesktopInput]::IsWindowVisible($_.MainWindowHandle) } | ForEach-Object {
    $r=New-Object DesktopInput+Rect
    if([DesktopInput]::GetWindowRect($_.MainWindowHandle,[ref]$r)) {
      [pscustomobject]@{ id=[string]$_.MainWindowHandle; title=$_.MainWindowTitle; appName=$_.ProcessName; x=$r.left; y=$r.top; width=$r.right-$r.left; height=$r.bottom-$r.top; active=$_.MainWindowHandle -eq [DesktopInput]::GetForegroundWindow() }
    }
  }
) | ConvertTo-Json -Compress
`);
export const focusWindowsScript = (id: string) =>
  windowsScript(
    [
      `$handle=[IntPtr]([long]${psString(id)})`,
      "if(![DesktopInput]::IsWindowVisible($handle)){ throw 'Window is no longer available' }",
      "[DesktopInput]::ShowWindow($handle,9) | Out-Null",
      "if(![DesktopInput]::SetForegroundWindow($handle)){ throw 'Windows refused to focus the window' }",
    ].join("\n"),
  );

export const WINDOWS_KEYS: Readonly<Record<string, number>> = {
  enter: 13,
  return: 13,
  tab: 9,
  escape: 27,
  esc: 27,
  space: 32,
  backspace: 8,
  delete: 46,
  del: 46,
  insert: 45,
  up: 38,
  arrowup: 38,
  down: 40,
  arrowdown: 40,
  left: 37,
  arrowleft: 37,
  right: 39,
  arrowright: 39,
  home: 36,
  end: 35,
  pageup: 33,
  pagedown: 34,
  capslock: 20,
  shift: 16,
  control: 17,
  ctrl: 17,
  alt: 18,
  meta: 91,
  super: 91,
  win: 91,
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, 112 + i])),
};
const modifiers = { shift: 16, control: 17, alt: 18, meta: 91 };
export function keyboardWindowsScript(
  action: Extract<DesktopUseAction, { type: "keyboard.type" | "keyboard.key" }>,
): string {
  if (action.type === "keyboard.type")
    return windowsScript(`[DesktopInput]::Text(${psString(action.text)})`);
  const mods = `[ushort[]]@(${(action.modifiers ?? []).map((m) => modifiers[m]).join(",")})`;
  const code = WINDOWS_KEYS[action.key.toLowerCase()];
  return windowsScript(
    code === undefined
      ? `[DesktopInput]::Character([char]${psString(action.key)},${mods})`
      : `[DesktopInput]::Press(${code},${mods})`,
  );
}
export const releaseWindowsKeysScript = (
  action: Extract<DesktopUseAction, { type: "keyboard.key" | "keyboard.type" }>,
) => {
  if (action.type === "keyboard.type")
    return windowsScript(
      `[DesktopInput]::ReleaseText(${psString([...new Set(action.text)].join(""))})`,
    );
  const code = WINDOWS_KEYS[action.key.toLowerCase()];
  const mods = (action.modifiers ?? []).map((m) => modifiers[m]);
  return windowsScript(
    code === undefined
      ? `[DesktopInput]::ReleaseCharacter([char]${psString(action.key)},[ushort[]]@(${mods.join(",")}))`
      : [...new Set([code, ...mods])].map((key) => `[DesktopInput]::ReleaseKey(${key})`).join("\n"),
  );
};
const buttonNumber = (button: DesktopUseMouseButton = "left") =>
  button === "left" ? 0 : button === "right" ? 1 : 2;
export const pointerWindowsScript = (action: {
  type: string;
  x?: number | undefined;
  y?: number | undefined;
  button?: DesktopUseMouseButton | undefined;
  count?: number | undefined;
  deltaX?: number | undefined;
  deltaY?: number | undefined;
}) =>
  windowsScript(
    [
      action.x === undefined || action.y === undefined
        ? ""
        : `[DesktopInput]::Move(${Math.round(action.x)},${Math.round(action.y)})`,
      action.type === "pointer.click"
        ? `for($i=0;$i -lt ${action.count ?? 1};$i++){ try { [DesktopInput]::Button(${buttonNumber(action.button)},$true) } finally { [DesktopInput]::Button(${buttonNumber(action.button)},$false) }; Start-Sleep -Milliseconds 80 }`
        : "",
      action.type === "pointer.down"
        ? `[DesktopInput]::Button(${buttonNumber(action.button)},$true)`
        : "",
      action.type === "pointer.up"
        ? `[DesktopInput]::Button(${buttonNumber(action.button)},$false)`
        : "",
      action.type === "pointer.scroll"
        ? `[DesktopInput]::Wheel(${action.deltaX ?? 0},${action.deltaY ?? 0})`
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );

export const dragWindowsScript = (action: Extract<DesktopUseAction, { type: "pointer.drag" }>) => {
  const duration = action.durationMs ?? 250,
    steps = Math.max(1, Math.min(120, Math.ceil(duration / 16))),
    button = buttonNumber(action.button);
  return windowsScript(`
[DesktopInput]::Move(${Math.round(action.from.x)},${Math.round(action.from.y)})
try {
  [DesktopInput]::Button(${button},$true)
  for($i=1;$i -le ${steps};$i++) {
    Start-Sleep -Milliseconds ${Math.round(duration / steps)}
    [DesktopInput]::Move([int][Math]::Round(${action.from.x}+(${action.to.x - action.from.x})*$i/${steps}),[int][Math]::Round(${action.from.y}+(${action.to.y - action.from.y})*$i/${steps}))
  }
} finally { [DesktopInput]::Button(${button},$false) }
`);
};
