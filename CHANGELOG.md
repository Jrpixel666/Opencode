# Changelog

## [0.2.0] - 2026-11-07

opencode·pixel now runs entirely on your phone. No computer, bridge or opencode server needed.

### Install

Download `opencode-pixel-0.2.0.apk` below and open it on your Pixel (Android 11+). Then **Add a provider**, paste your API key and start chatting. It installs as an update over 0.1.0.

### Changed

- Chats go straight from the phone to the provider, with your own API key: OpenCode Zen, OpenCode Go, Anthropic, OpenAI, Google Gemini, OpenRouter, DeepSeek, xAI, Groq, Mistral and ~200 more from models.dev, plus custom OpenAI-compatible servers (Ollama, LM Studio).
- Balances are shown in **tokens**, not money: tokens used (today / 5 h / 7 d / 30 d) and tokens left per provider and per model, from live credit (OpenRouter, DeepSeek, Moonshot), the credit you enter, a token allowance, or a per-model token limit.
- API keys are encrypted with the Android Keystore and only sent to that provider's hosts; chats and usage are stored on the phone.
- Export and import chats; share a chat as text; retry the last reply.

### Removed

- The Node bridge server, the login screen and server setup. The opencode coding-agent features (files, terminal, sessions on your computer) went with them.

## [0.1.0] - 2026-11-07

First release: a phone client for `opencode serve` running on your computer, with a Node bridge, per-model balances and an Android wrapper.
