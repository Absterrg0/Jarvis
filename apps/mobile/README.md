# Jarvis Mobile

> [!WARNING]
> Jarvis Mobile is currently in development and is distributed through internal preview builds.

## Quickstart

> [!NOTE]
> Uses native modules so using Expo Go is not supported. You need to use the Expo Dev Client.

This app has three variants:

- `development`: Expo dev client, installable side-by-side as `Jarvis Dev`
- `preview`: persistent internal preview build, installable side-by-side as `Jarvis Preview`
- `production`: store/release build as `Jarvis`

Run commands from `apps/mobile`.

T3 Connect is optional and disabled in a fresh clone. Public configuration belongs in the
repository-root `.env` or `.env.local`, not an `apps/mobile/.env` file. See
[`../../.env.example`](../../.env.example).

## Development

Start Metro for the dev client:

```bash
vp run dev:client
```

Build and run the local iOS dev client:

```bash
vp run ios:dev
```

If your Xcode account only has a Personal Team, use a bundle identifier you control and opt into the
reduced-capability local build. Personal Team builds omit the widget and share extensions, push
entitlement, and native Sign in with Apple entitlement; builds without this opt-in are unchanged.

```bash
T3CODE_IOS_PERSONAL_TEAM=1 \
T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID=com.example.t3code.dev \
vp run ios:dev
```

Build and install a self-contained Release app that does not need Metro:

```bash
vp run ios:release
```

The Personal Team equivalent also needs a unique bundle identifier:

```bash
T3CODE_IOS_PERSONAL_TEAM=1 \
T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID=com.example.t3code \
vp run ios:release
```

Build and run the local iOS preview app:

```bash
vp run ios:preview
```

Force the review diff highlighter engine:

```bash
EXPO_PUBLIC_REVIEW_HIGHLIGHTER_ENGINE=javascript vp run ios:dev
```

`javascript` is the default and recommended setting for the review diff screen. Set `EXPO_PUBLIC_REVIEW_HIGHLIGHTER_ENGINE=native` only when you explicitly want to test the native Shiki engine.

Inspect the resolved Expo config for a variant:

```bash
vp run config:dev
vp run config:preview
```

Run static checks for mobile native code:

```bash
node ../../scripts/mobile-native-static-check.ts
```

The native lint task runs SwiftLint for Swift plus ktlint and detekt for Kotlin. Missing native tools are reported as warnings and skipped locally. CI installs the default toolset from `apps/mobile/Brewfile` before running the native checks.

## EAS Builds

The fork does not inherit the upstream Expo owner or project. Set `JARVIS_EXPO_OWNER` and
`JARVIS_EXPO_PROJECT_ID` in the authenticated EAS environment before running a cloud build. The
project ID enables EAS Update; without it, local config inspection and local native builds work but
OTA is disabled. Do not run `eas init` from this checkout unless the Jarvis Expo project has been
created and approved separately.

CI uses Expo fingerprinting with the `preview:dev` profile to reuse an existing compatible build when possible, or start a new internal EAS build when native runtime inputs change. Production and default local builds continue to use the `appVersion` runtime policy.

For preview or production EAS environments, set `T3CODE_CLERK_PUBLISHABLE_KEY`,
`T3CODE_CLERK_JWT_TEMPLATE`, and `T3CODE_RELAY_URL`
as EAS environment variables. Expo config maps the canonical values into the mobile build.

Android push builds also need Firebase client configuration for the package used by that
environment. The preview build uses `google-services.preview.json`, registered for
`com.abstergo.jarvis.preview`. Firebase treats this client file as non-secret configuration, and
keeping it with the source lets Expo calculate the same fingerprint before upload and inside the
EAS builder.

This client configuration lets the installed app receive FCM messages. Sending Android
notifications through Expo also requires an FCM V1 service-account key in the EAS Android
credentials. That private server credential must never be committed, and
`google-services.preview.json` cannot be used in its place.

Create a PR preview dev-client build manually:

```bash
vp run eas:ios:preview:dev
```

Create a cloud dev-client build:

```bash
vp run eas:ios:dev
```

Create a persistent preview build:

```bash
vp run eas:ios:preview
```

Android equivalents:

```bash
vp run eas:android:dev
vp run eas:android:preview:dev
vp run eas:android:preview
```

For a standalone Android preview APK, use the `preview` profile. It uses internal distribution and
sets `android.buildType` to `apk` without enabling the development client:

```bash
JARVIS_EXPO_OWNER=<jarvis-expo-owner> \
JARVIS_EXPO_PROJECT_ID=<jarvis-expo-project-id> \
vp run eas:android:preview
```

The same native project can build a standalone local APK after Android SDK and JDK 17 are installed:

```bash
APP_VARIANT=preview EXPO_NO_GIT_STATUS=1 \
pnpm exec expo prebuild --clean --platform android
./android/gradlew -p android :app:assembleRelease \
  -PreactNativeArchitectures=arm64-v8a \
  --no-daemon --max-workers=2 --console=plain
```

Install the resulting APK on a USB-connected device with USB debugging enabled:

```bash
adb install -r android/app/build/outputs/apk/release/app-release.apk
```
