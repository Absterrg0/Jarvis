export interface WindowsSetupPayload {
  readonly id: string;
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly bytes: number;
    readonly sha256: string;
  }>;
}

export function verifyArtifactBundle(input: {
  readonly artifactPath: string;
  readonly aliasPath: string;
  readonly manifestPath: string;
  readonly checksumPath: string;
  readonly provenancePath: string;
}): Promise<{
  readonly manifest: unknown;
  readonly provenance: unknown;
  readonly payloadIds: ReadonlyArray<string>;
}>;

export function verifyInstalledPayload(payload: WindowsSetupPayload, root: string): Promise<void>;
