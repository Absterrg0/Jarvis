# Circe relay self-hosting

> For maintainers. This is how to run your own relay. There is no shared production relay.

The relay is Circe-owned. The stack is `CirceRelay`, the package is `@circe/relay`, and the production database is `circerelay`. Clients ship with no relay configured. You provide the Cloudflare zones, the database, the Clerk application, and the domains, then point your builds at the result.

Follow [Circe Connect setup](./connect-setup.md) for client-side Clerk details and [relay observability](./relay-observability.md) once the deployment is up.

## Prerequisites

You need accounts you control. Nothing here reuses T3 infrastructure.

- Cloudflare account with an API token that can manage Workers, Hyperdrive, Queues, Tunnels, DNS zones, and custom domains. Record the account ID.
- Two DNS zones in that account, usually one for the relay API and one for managed tunnel endpoints. They can be the same zone.
- PlanetScale organization with an API token ID and token that can create databases, branches, and roles.
- Axiom organization and token only if you want trace storage. Without them the stack still deploys but you get no Axiom datasets or ingest tokens.
- Apple Developer APNs key only if you want iOS push. Set `APNS_ENABLED=false` for an Android-only relay and skip the rest of the APNs values.

## Clerk application

Create your own Clerk application. The relay trusts only this instance.

- Copy the publishable key and secret key from API keys. The secret key lives only in the relay environment, never in client builds.
- Create a JWT template. The template name goes to clients as `CIRCE_CLERK_JWT_TEMPLATE`. Its `aud` claim must equal the relay `CLERK_JWT_AUDIENCE` value. The names can stay `circe-relay` and `circe-relay` inside your own instance, or pick your own pair, as long as the two sides match.
- Create a public OAuth application for the CLI with authorization-code exchange and PKCE. Allow two redirect URIs: the loopback `http://127.0.0.1:34338/callback` and the hosted `<hosted-app>/connect/callback` where `<hosted-app>` is the origin you ship in `CIRCE_HOSTED_APP_URL`. Headless and SSH logins use the hosted callback, so that entry must exist. Enable `openid`, `profile`, and `email` scopes, then copy the client ID for `CIRCE_CLERK_CLI_OAUTH_CLIENT_ID`.
- Passkeys need no extra relay setting. The mobile and desktop builds derive the relying party domain from the Clerk publishable key. Set an explicit RP override only when Clerk returns a different RP ID or you must entitle several domains.

Lock sign-ups in Clerk with an allowlist or Restricted mode if the relay is not meant to be open.

## Relay environment

Copy the example and fill in your values:

```sh
cp infra/relay/.env.example infra/relay/.env
```

Required values in `infra/relay/.env`:

```dotenv
RELAY_API_ZONE_NAME=example.com
RELAY_TUNNEL_ZONE_NAME=tunnels.example.com
CLERK_PUBLISHABLE_KEY=pk_live_...
CLERK_SECRET_KEY=sk_live_...
CLERK_JWT_AUDIENCE=circe-relay
```

Optional:

```dotenv
RELAY_DOMAIN=relay.example.com
APNS_ENABLED=false
APNS_ENVIRONMENT=sandbox
APNS_TEAM_ID=...
APNS_KEY_ID=...
APNS_BUNDLE_ID=...
APNS_PRIVATE_KEY=...
FCM_SERVICE_ACCOUNT={...}
```

`RELAY_DOMAIN` overrides the derived `relay.<RELAY_API_ZONE_NAME>` hostname. Leave it unset unless you need a fixed name. `FCM_SERVICE_ACCOUNT` is the Firebase service-account JSON and stays out of app builds. Account-level Cloudflare, PlanetScale, and Axiom credentials come from the process environment or your CI environment, not from this file.

## Deploy

Deploy `prod` first. It owns the retained database and DNS zones. Personal stages branch from it.

```sh
vp run --filter @circe/relay deploy --stage prod --yes
```

The deploy writes the relay URL and public tracing configuration back to the repository-root `.env` so the next source build points at this relay. For a personal stage, pass an explicit stage and env file:

```sh
vp run --filter @circe/relay deploy -- --stage "$USER" --env-file .env.local
```

Personal stages reuse the production zones and create an isolated PlanetScale branch. Never deploy a personal stage as `prod`.

## Point builds at the deployment

Set these in the repository-root `.env` or `.env.local` before building clients. They are public identifiers. The deploy step already filled in the relay URL.

```dotenv
CIRCE_RELAY_URL=https://relay.example.com
CIRCE_CLERK_PUBLISHABLE_KEY=pk_live_...
CIRCE_CLERK_JWT_TEMPLATE=circe-relay
CIRCE_CLERK_CLI_OAUTH_CLIENT_ID=...
CIRCE_HOSTED_APP_URL=https://app.example.com
```

Leave a value unset to build with cloud features disabled. Rebuild web, desktop, CLI, and mobile after changing them. Mobile EAS environments need the same publishable key, JWT template name, and relay URL. The hosted app origin defaults to the web build's own origin when `CIRCE_HOSTED_APP_URL` is unset, but the CLI out-of-band flow needs the explicit origin to reach the right `/connect/callback`.

## Operate

Each user is capped by default at 3 managed tunnels, 10 environment links, and 20 devices. Re-linking the same environment or re-registering the same device does not count twice. Raise or lower one user with a row in `relay_managed_tunnel_limits`, `relay_environment_link_limits`, or `relay_device_limits`. The relay returns `environment_link_limit_exceeded` or `device_limit_exceeded` when a new allocation would exceed the cap, so ask the user to deregister an unused environment or device before retrying.

Watch the Axiom `*-traces-prod` dataset or the provisioned recent-spans view for DPoP failures, link proofs, and delivery errors. A `time_window` DPoP failure usually means clock skew between client and relay. Unlink commits revocation before external teardown, so a failed tunnel or DNS cleanup leaves the link usable and safe to retry.
