/// <reference types="vite-plus/client" />

import type { DesktopBridge } from "@t3tools/contracts";

interface ImportMetaEnv {
  readonly VITE_HTTP_URL: string;
  readonly VITE_WS_URL: string;
  readonly VITE_HOSTED_APP_URL: string;
  readonly VITE_HOSTED_APP_CHANNEL: string;
  readonly VITE_CLERK_PUBLISHABLE_KEY: string;
  readonly VITE_CLERK_JWT_TEMPLATE: string;
  readonly VITE_CLERK_CLI_OAUTH_CLIENT_ID: string;
  readonly VITE_RELAY_OTLP_TRACES_URL: string;
  readonly VITE_RELAY_OTLP_TRACES_DATASET: string;
  readonly VITE_RELAY_OTLP_TRACES_TOKEN: string;
  readonly APP_VERSION: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare global {
  interface Window {
    desktopBridge?: DesktopBridge;
    jarvisCompanion?: {
      /** True for the hidden report-only host renderer, never for the local setup surface. */
      readonly relayMode?: boolean;
      readonly recognizeSpeech: () => Promise<
        | { readonly ok: true; readonly transcript: string }
        | { readonly ok: false; readonly message: string }
      >;
      readonly speak: (text: string) => Promise<void>;
      readonly submitPairingLink: (url: string) => Promise<{
        readonly ok: boolean;
        readonly message?: string;
      }>;
      readonly submitTranscript: (text: string) => Promise<{
        readonly ok: boolean;
        readonly message?: string;
      }>;
      readonly taskStatus: (state: string, detail: string, kind: string) => Promise<void>;
      readonly setAttentionTarget: (target: {
        readonly projectId: string;
        readonly threadId: string;
      }) => Promise<{ readonly accepted: boolean }>;
      readonly reportRelayStatus?: (available: boolean) => Promise<{ readonly accepted: boolean }>;
      readonly getSetup?: () => Promise<unknown>;
      readonly saveDefault?: (selection: unknown) => Promise<unknown>;
      readonly openHost?: () => Promise<boolean>;
      readonly minimize?: () => Promise<void>;
      readonly testVoice?: () => Promise<unknown>;
      readonly bubbleReady?: () => Promise<{ readonly accepted: boolean }>;
    };
  }
}
