# Circe Mobile

> [!WARNING]
> Circe Mobile is currently in development and is distributed through internal preview builds.

## Quickstart

> [!NOTE]
> Uses native modules so using Expo Go is not supported. You need to use the Expo Dev Client.

This app has three variants:

- `development`: Expo dev client, installable side-by-side as `Circe Dev`
- `preview`: persistent internal preview build, installable side-by-side as `Circe Preview`
- `production`: store/release build as `Circe`

Run commands from `apps/mobile`.

Circe Connect is optional and disabled in a fresh clone. Public configuration belongs in the
repository-root `.env` or `.env.local`, not an `apps/mobile/.env` file. See
[`../../.env.example`](../../.env.example).

## Development

Start Metro for the dev client:

```bash
vp run dev:client
```

Metro keeps its transform cache between ordinary starts. If the cache itself is causing stale or
invalid output, clear it for one development-client start:

```bash
vp run dev:client:reset
```

Run that reset once after installing or changing the Uniwind dependency patch. Cached transforms
can otherwise reference its previous pnpm package path. Ordinary Metro starts still keep the cache.

Component edits use Fast Refresh. See [mobile development lifecycle](../../docs/internals/mobile-development.md)
before changing runtime ownership or refresh behavior.

Build and run the local iOS dev client:

```bash
vp run ios:dev
```

After changing a native dependency patch, rerun CocoaPods before rebuilding an existing iOS
project. pnpm gives each patch hash a new package path; Pods can otherwise keep compiling the
previous directory.

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

Preview and production variants use Expo fingerprinting so OTA updates only reach binaries with matching native dependencies, config plugins, and patches. CI uses the `preview:dev` profile to reuse a compatible native build when possible.

The development variant uses `appVersion` to avoid recalculating the native fingerprint for each Metro launch manifest. `MOBILE_VERSION_POLICY` can override either default. If you distribute a custom Release build with the development identity and publish OTA updates to it, set `MOBILE_VERSION_POLICY=fingerprint` for both its build and updates. Changing the runtime policy requires a native rebuild for OTA matching; an existing dev client can still load local Metro bundles.

For preview or production EAS environments, set `CIRCE_CLERK_PUBLISHABLE_KEY`,
`CIRCE_CLERK_JWT_TEMPLATE`, and `CIRCE_RELAY_URL`
as EAS environment variables. Expo config maps the canonical values into the mobile build.

Android push builds also need Firebase client configuration for the package used by that
environment. Keep the preview `google-services.json` file outside this repository and set
`GOOGLE_SERVICES_JSON` to its path for local builds. In EAS, upload the same file as a secret file
environment variable named `GOOGLE_SERVICES_JSON` for the `preview` environment. EAS then exposes
the temporary file path while resolving the native Android config.

For example, from this checkout:

```bash
eas env:set --environment preview --name GOOGLE_SERVICES_JSON \
  --type file --visibility secret --value /path/to/google-services.preview.json
```

The file must be registered for `com.abstergo.circe.preview` in the Firebase project used by the
EAS FCM v1 credential. Firebase client config is public at runtime, but keeping it out of Git
avoids committing project configuration and makes the build input explicit.

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
CIRCE_EXPO_OWNER=<circe-expo-owner> \
CIRCE_EXPO_PROJECT_ID=<circe-expo-project-id> \
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
