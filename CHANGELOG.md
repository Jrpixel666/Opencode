# Changelog

## [0.1.0] - 2026-11-07

First release of opencode·pixel, a Pixel 9 app for [opencode](https://opencode.ai).

### Install

1. Download `opencode-pixel-0.1.0.zip` below and unzip it on the computer that runs opencode (Node 20+, no other dependencies).
2. `cp .env.example .env` and set `OCB_PASSWORD`.
3. Start `opencode serve`, then `npm start`, then `tailscale serve --bg 7878`.
4. On the Pixel, open the Tailscale HTTPS address in Chrome and choose **Add to Home screen**.

Want to look first? `npm run demo`, then open http://localhost:7878 and log in as `me` / `demo`.

On the phone you can either install `opencode-pixel-0.1.0.apk` (Android 11+, enter your bridge address on first launch) or open the address in Chrome and **Add to Home screen**.

### Features

- Android app (APK): native camera, Google voice typing, notifications, keep-screen-on, share-to-app, themed icon.

- Chat with opencode: live streaming replies, collapsible thinking and tool steps, permission approve/deny, model and agent pickers, stop, camera/photo/PDF attachments, voice dictation, `/commands`.
- Login for the app with signed cookies and rate limiting; connect model providers from the phone (OAuth sign-in or API key). Keys stay on your computer.
- Balance per provider and per model: live from OpenRouter, DeepSeek, Moonshot and SiliconFlow; tracked for OpenCode Zen and others; spend per model over 5 h / 24 h / 7 d / 30 d; optional OpenCode Go-style limits.
- Warm design in the style of the Claude Android app, light and dark.
- Pixel touches: back gesture, swipe for the drawer, share-to-app, home-screen shortcuts, notifications, keep screen on, offline app shell.
- systemd user units for running it on Omarchy / Arch.
