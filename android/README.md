# opencode·pixel for Android

A small native app (Java, no extra libraries) that runs the opencode·pixel web app full
screen, for Android 11+ and tuned for the Pixel 9. The app itself still comes from the bridge
on your computer, so the bridge needs to be running (see the main README).

What the native shell adds:

- First-run screen where you enter your bridge address (change it later in Settings → Server)
- Camera and photo/file picker for attachments
- Voice typing through Google's speech recognizer
- "Reply finished" notifications while the app is in the background
- Keep screen on while opencode is working
- Status and navigation bars that follow light/dark mode; edge-to-edge layout with the keyboard
- Android back gesture closes the drawer, pages and sheets
- Share text from any app into a new chat; long-press shortcuts for New chat, Balance, Account
- Themed (Material You) icon
- Provider sign-in pages and other links open in your browser

## Install

1. Download `opencode-pixel-<version>.apk` from the repo's Releases page.
2. Open it on the Pixel and allow your browser or Files app to install unknown apps when asked.
3. Open **opencode**, enter your bridge address (e.g. `https://my-pc.tail1234.ts.net`) and log in.

Notifications are best effort: Android pauses background apps after a while, so you're
notified for replies that finish soon after you switch away.

## Build

Needs JDK 17+, Gradle 8.14 and the Android SDK (platform 35).

```bash
cd android
export ANDROID_HOME=~/Android/Sdk
gradle assembleRelease            # unsigned: app/build/outputs/apk/release/
```

To sign, point these at your keystore:

```bash
export OCP_KEYSTORE=/path/to/opencode-pixel.keystore
export OCP_KEYSTORE_PASSWORD=...        # also used as the key password
export OCP_KEY_ALIAS=opencode-pixel     # optional, this is the default
gradle assembleRelease
```

Updates only install over an existing copy when they're signed with the same key, so keep
the keystore safe and use the same one every time.

## Signed APKs on GitHub releases

Add two repository secrets (Settings → Secrets and variables → Actions):

| Secret | Value |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | `base64 -w0 opencode-pixel.keystore` |
| `ANDROID_KEYSTORE_PASSWORD` | the keystore password |

The Release workflow then builds, signs and attaches the APK to each release. If a release
was published before the secrets existed, run **Actions → Release → Run workflow** to attach it.
