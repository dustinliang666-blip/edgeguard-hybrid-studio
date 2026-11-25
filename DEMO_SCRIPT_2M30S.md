# EdgeGuard Hybrid Studio | Demo recording plan

**02:24 · English · 1280×720.** Follow one synthetic customer ticket through three runs in the same Web session. Each row is one edit block. Read only the last column. For TTS and SRT, use each sentence as a cue, sync it to its audio, and hold the final frame until the next block.

| Clock | Picture and operator action | English voice-over |
| --- | --- | --- |
| 00:00–00:17 | Open the Vite app in a fresh tab. Frame **Sandbox Simulation**, **App Check idle** and the **Customer ticket** example. Click the example to select **Triage**. | A customer lost access to the billing portal after a password reset. A support engineer needs to summarize the issue. What happens to the phone number and the credential someone pasted into the same ticket? |
| 00:17–00:35 | Frame the **Email**, **Phone**, **IP address** and **Secret** badges under **Input**. Scroll to **Preview redacted egress payload** and click **Inspected input** to highlight the four spans. | EdgeGuard scans the ticket in the browser. Here it finds four things, including the token in the callback note. This is a synthetic ticket. Every response in this walkthrough comes from a local simulation. |
| 00:35–00:56 | Keep the default **Strict privacy** and **Simulate Nano ready** settings. Click **Cloud payload** and show “No cloud payload for this route.” Frame `ONLY_ON_DEVICE`, click **Run simulation**, then frame **Last response** and **Simulated · On device**. | With strict privacy on and the local model marked ready, the credential keeps the whole ticket on this device. There is no cloud prompt to inspect. The response shows the issue and a suggested next action, with its simulated source beside it. |
| 00:56–01:23 | Turn off **Simulate Nano ready**. Leave **Redact before cloud** and **Allow cloud inference** on. Click **Compare**. Scroll the payload pane to the input and frame the placeholders. Click **Run simulation** and turn off **Restore contact details locally** to show the email placeholder in the response. | Now suppose the local model is unavailable. The engineer allows cloud fallback with redaction. The billing issue survives, but the email, phone number, IP address and credential become placeholders. The cloud side of this comparison includes the task instructions too. In the simulated response, we can see the email placeholder exactly as it came back. |
| 01:23–01:45 | Enable **Offline routing** with Nano still off. Show **BLOCKED**, then click **Run simulation** once. Frame **Session trace** and **Session telemetry**. Click **Export telemetry JSON**. | Now take the same ticket offline. With the local model still unavailable, the router stops before inference. Across three attempts, the trace shows one on device, one in the cloud and one blocked. The exported counts belong to the sandbox session. |
| 01:45–02:05 | Show the downloaded `edgeguard-telemetry.json` with `live.totalRuns` at 0 and `sandbox.totalRuns` at 3. Cut to the README's **Enable live inference** section and frame the Firebase and App Check setup. | The report contains counts and timings. The ticket itself stays out of the file. To use live cloud inference, connect your own Firebase web app and configure App Check. The live adapter requests a token before it sends the inspected prompt to Gemini. |
| 02:05–02:24 | Cut to the prepared package listing and manifest output below. Frame `sidepanel.html`, `background.js` and the three permissions. End on the Vite workspace with the three-run trace. | The same workspace ships as a Chrome side panel. Its worker reads a selection when you click Capture tab text. Whether the text starts in a ticket or a browser tab, you can inspect the cloud prompt before running the task. |

## Operator preflight

- From the directory containing `package.json`, use Node.js 24.12.0 or later. Run `npm ci`, then `npm run build`. Run the PowerShell inspection below before starting `npm run dev`. Open the URL Vite prints. All shots use the unconfigured sandbox, local files or the package listing.
- Use a 1280×720 viewport. Keep the same tab through all three runs and use the labeled controls as capture targets. Scroll each target into view before taking a still. Where a block calls for two views, cut between the captured states in the order listed. Use the block boundaries when assembling the MP4.
- For the report shot, open the downloaded JSON separately so the three-run trace remains available. Keep measured latency as recorded. For the README shot, frame the setup instructions only.
- For the package shot, run the following in PowerShell from the same directory. The first command checks worker syntax and is silent on success. The next two show the actual files and the fields Chrome reads.

```powershell
node --check dist-extension/background.js
Get-ChildItem dist-extension -Name
Get-Content dist-extension/manifest.json -Raw | ConvertFrom-Json |
    Select-Object manifest_version, permissions, side_panel, background | ConvertTo-Json -Depth 3
```

The manifest should show version `3`, permissions `sidePanel`, `activeTab` and `scripting`, the side-panel entry `sidepanel.html` and the service worker `background.js`. [Manifest source](extension/manifest.json)
