# EdgeGuard Hybrid Studio

**#BuildHybridAI 2026 · Best Web/Chrome App**

**Tagline** · Inspect a support ticket and see exactly what could reach the cloud before you run Gemini.

## Inspiration

A customer needs help getting back into a billing portal. Their ticket includes a phone number and a credential someone pasted during troubleshooting. A support engineer needs the account-access details to survive a summary, but has little reason to send the credential with them. We wanted the engineer to be able to read the outgoing prompt before making that call.

## What it does

Paste text into the Web app or select a passage in Chrome and click **Capture tab text** in the side panel. EdgeGuard marks common sensitive data patterns and shows the proposed route. In the synthetic ticket, strict privacy keeps the original on the device when Gemini Nano is ready. When Nano is unavailable and masked fallback is allowed, **Compare** shows the original beside the exact prompt eligible for cloud inference. Going offline with Nano unavailable stops the request.

The default **Sandbox Simulation** lets judges reproduce those three decisions offline after loading the app. It generates deterministic local responses and labels each simulated source. **Live Firebase AI Logic** is available for users who configure their own runtime.

## How we built it

The Web app and the Manifest V3 side panel share a React workspace and a TypeScript router. The scanner uses patterns for emails, phone numbers, IP addresses, credentials and IDs, and checks payment card candidates with Luhn. It masks detected spans before constructing a cloud-eligible prompt. Users can review the remaining text for details the scanner missed.

The live adapter uses Firebase AI Logic with `GoogleAIBackend`. The router selects `ONLY_ON_DEVICE`, `PREFER_ON_DEVICE` or `PREFER_IN_CLOUD`. The cloud model is `gemini-2.5-flash`. Live cloud requires the user's Firebase Web configuration and an App Check token. The Web flow uses `ReCaptchaEnterpriseProvider`. For a test project, the side panel requires the Web configuration, site key and a registered App Check debug token because Chrome restricts remote scripts there.

## Challenges we ran into

An SDK preference can lead to either backend. We build one masked prompt for both paths, then check model availability again before a live run. If the check reveals a new cloud payload, the engineer sees it and must confirm. For local-only requests, the adapter stops before model dispatch when Chrome exposes only the legacy Nano API.

## Accomplishments

Both packages build from the same workspace. The verified suite passed 109 tests across 7 files, including SDK inputs checked with mocks and capture tests against the packaged worker. One regression case puts the last four digits of a card on the next line, beyond the capture limit. The worker discards the leading groups too.

## What we learned

A route describes where a prompt *can* go. The source reported after inference tells the engineer where the answer came from. Keeping those visible separately also lets the session report record a blocked attempt or an unknown source. Its JSON contains run metadata and counts, and keeps the ticket text out of the export.

## What's next

Add organization-specific identifier patterns and evaluate production attestation options for the Chrome side panel.

## Built with

TypeScript, React 19.2.9, Firebase 13.4.0, Firebase AI Logic, Firebase App Check, Chrome Manifest V3, Vite 8.3.8 and Vitest 4.1.12.

## Try it

- Public MIT repository · <https://github.com/dustinliang666-blip/edgeguard-hybrid-studio>
- Hosted Web app · <https://dustinliang666-blip.github.io/edgeguard-hybrid-studio/>
- Demo video · <https://youtu.be/CTtrGy49vu0>
- Judge walkthrough and local setup · [README](README.md) · [English demo script](DEMO_SCRIPT_2M30S.md)
