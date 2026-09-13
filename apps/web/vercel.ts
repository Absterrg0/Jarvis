import { matchers, routes, type Transform, type VercelConfig } from "@vercel/config/v1";

/**
 * Hosted-web routing is operator-owned. The release workflow supplies
 * `T3CODE_WEB_ROUTER_URL` and the channel domains for a deployment; the T3
 * defaults keep upstream builds pointing at their existing domains.
 */
function hostFrom(value: string | undefined, fallbackHost: string): string {
  const trimmed = value?.trim();
  if (!trimmed) return fallbackHost;
  try {
    return new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`).host;
  } catch {
    return fallbackHost;
  }
}

const ROUTER_HOST = hostFrom(process.env.T3CODE_WEB_ROUTER_URL, "app.t3.codes");
const HOSTED_WEB_CHANNEL_COOKIE = "t3code_web_channel";
const LATEST_ORIGIN = `https://${hostFrom(process.env.T3CODE_WEB_LATEST_DOMAIN, "latest.app.t3.codes")}`;
const NIGHTLY_ORIGIN = `https://${hostFrom(process.env.T3CODE_WEB_NIGHTLY_DOMAIN, "nightly.app.t3.codes")}`;
const CLEAN_CHANNEL_QUERY_TRANSFORMS = [
  {
    type: "request.query",
    op: "delete",
    target: { key: "channel" },
  },
] satisfies Transform[];

function channelCookie(channel: "latest" | "nightly"): string {
  return [
    `${HOSTED_WEB_CHANNEL_COOKIE}=${channel}`,
    "Path=/",
    "Max-Age=31536000",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ].join("; ");
}

export const config: VercelConfig = {
  buildCommand:
    'vp run --filter @t3tools/web build && node ../../scripts/apply-web-brand-assets.ts --channel "${VITE_HOSTED_APP_CHANNEL:-latest}"',
  git: {
    deploymentEnabled: false,
  },
  installCommand:
    "npm install -g vite-plus && vp install --ignore-scripts --filter '@t3tools/scripts...' --filter '@t3tools/web...'",
  routes: [
    {
      src: "/__t3code/channel",
      has: [matchers.query("channel", "nightly")],
      transforms: CLEAN_CHANNEL_QUERY_TRANSFORMS,
      headers: {
        Location: "/",
        "Set-Cookie": channelCookie("nightly"),
      },
      status: 302,
    },
    {
      src: "/__t3code/channel",
      transforms: CLEAN_CHANNEL_QUERY_TRANSFORMS,
      headers: {
        Location: "/",
        "Set-Cookie": channelCookie("latest"),
      },
      status: 302,
    },
    {
      src: "/(.*)",
      has: [matchers.host(ROUTER_HOST), matchers.cookie(HOSTED_WEB_CHANNEL_COOKIE, "nightly")],
      dest: `${NIGHTLY_ORIGIN}/$1`,
    },
    {
      src: "/(.*)",
      has: [matchers.host(ROUTER_HOST)],
      dest: `${LATEST_ORIGIN}/$1`,
    },
  ],
  rewrites: [routes.rewrite("/(.*)", "/index.html")],
};
