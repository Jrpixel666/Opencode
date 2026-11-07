# opencode·pixel for Android

The whole app lives here. A small native shell (Java, no extra libraries, Android 11+) hosts
the interface from `app/src/main/assets/web`, served at `https://app.opencode.local` inside a
WebView, and adds:

- **Keys and requests.** API keys are encrypted with an AES key held in the Android Keystore
  (`KeyStore.java`). The page never sees a key: it asks the native layer to make each request,
  and the key is added only if the request goes to one of that provider's own hosts.
- Streaming HTTP for replies, camera capture and photo picking, Google voice typing,
  notifications, keep-screen-on, saving exported chats, the share sheet, system bar colours,
  the back gesture, launcher shortcuts, and a themed icon.

Links in replies open in your browser.

## Build

Needs JDK 17+, Gradle 8.14 and the Android SDK (platform 35).

```bash
cd android
export ANDROID_HOME=~/Android/Sdk
gradle assembleRelease            # unsigned: app/build/outputs/apk/release/
```

To sign:

```bash
export OCP_KEYSTORE=/path/to/opencode-pixel.keystore
export OCP_KEYSTORE_PASSWORD=...        # also used as the key password
export OCP_KEY_ALIAS=opencode-pixel     # optional, this is the default
gradle assembleRelease
```

Updates only install over an existing copy when signed with the same key, so keep the
keystore safe and use it every time.

## Signed APKs on GitHub releases

Add two repository secrets (Settings → Secrets and variables → Actions):

| Secret | Value |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | `base64 -w0 opencode-pixel.keystore` |
| `ANDROID_KEYSTORE_PASSWORD` | the keystore password |

The Release workflow then builds, signs and attaches the APK to each release. If a release was
published before the secrets existed, run **Actions → Release → Run workflow** to attach it.
