export function resolveNativeBinaryPath(
  packageRoot: string,
  platform?: string,
  arch?: string,
  fileExists?: (path: string) => boolean,
  isFile?: (path: string) => boolean,
): string;
