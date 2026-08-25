// @effect-diagnostics nodeBuiltinImport:off - Electron's tray icon path is a small native boundary.
import * as NodePath from "node:path";

const DEV_ICON_RELATIVE_PATH = ["assets", "jarvis", "jarvis-universal-1024.png"] as const;

export type CompanionTrayIconPathInput = Readonly<{
  readonly packaged: boolean;
  readonly appPath: string;
  readonly resourcesPath: string;
  readonly exists?: (path: string) => boolean;
}>;

/**
 * Electron's development app path is usually `apps/companion/dist-electron`,
 * so resolving two parents lands in `apps/assets`. Walk to the repository root
 * explicitly and select an existing candidate before the Tray is constructed.
 */
export function resolveCompanionTrayIconPath(input: CompanionTrayIconPathInput): string {
  if (input.packaged) return NodePath.join(input.resourcesPath, "icon.png");

  const devCandidates = [
    NodePath.resolve(input.appPath, "../../", ...DEV_ICON_RELATIVE_PATH),
    NodePath.resolve(input.appPath, "../../../", ...DEV_ICON_RELATIVE_PATH),
    NodePath.resolve(input.appPath, "../../../../", ...DEV_ICON_RELATIVE_PATH),
  ];
  const exists = input.exists ?? (() => true);
  return devCandidates.find((candidate) => exists(candidate)) ?? devCandidates[0]!;
}
