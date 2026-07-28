# Amin AI — Browser Automation Worker

Playwright-based worker that plays back a Timeline AI "Browser Automation Contract v1"
JSON against the real official page, records the screen, and returns an MP4.

**Honest note on testing:** this code is syntax-checked and its request-handling logic
(auth, contract-version rejection, field validation) is verified — I don't have a
sandbox with Playwright's browser binaries available to test the actual recording
end-to-end. Test that part for real after deploying (see "Smoke test" below) before
wiring it into production.

## What it does

1. `POST /record` with a Timeline AI v1 payload
2. Opens the official page in headless Chromium
3. Plays back each timeline entry in real time (Open / Scroll / Highlight / Click / Wait),
   using a best-effort text search since `target` is plain language, never a CSS selector
4. Records the whole session as video
5. Converts the recording to MP4 with ffmpeg
6. Returns the MP4 bytes directly in the HTTP response

## Deploy (Render.com free tier — recommended, has a Docker-native free web service)

1. Push this folder to a GitHub repo (or a subfolder of your existing platform repo)
2. Render dashboard → New → Web Service → connect the repo
3. Environment: **Docker** (it will auto-detect the `Dockerfile`)
4. Instance type: **Free**
5. Environment variables:
   - `WORKER_SECRET` = a long random string (e.g. generate with `openssl rand -hex 32`) — **required**, the server refuses all requests without a matching header
6. Deploy. Render gives you a URL like `https://amin-browser-worker.onrender.com`

Railway.app works the same way (Docker-native, has a free tier) if you prefer it.

**Free-tier caveat:** free web services on both platforms sleep after inactivity and take
10–30s to wake on the next request — expect the first call after idle time to be slow.
This doesn't cost anything extra, it's just a real constraint of free hosting.

## Smoke test after deploying

```bash
curl https://YOUR-WORKER-URL/health
# {"status":"ok","supportedSchemaMajorVersion":"1"}

curl -X POST https://YOUR-WORKER-URL/record \
  -H "Content-Type: application/json" \
  -H "X-Worker-Secret: YOUR_WORKER_SECRET" \
  -d '{
    "schemaVersion": "1.0",
    "scriptId": 1,
    "rowId": 2,
    "officialUrl": "https://example.com",
    "totalDurationSeconds": 10,
    "sceneCount": 1,
    "timeline": [
      { "sceneId": 1, "start": 0, "end": 10, "officialUrl": "https://example.com", "action": "Open", "target": "official page", "highlight": false }
    ]
  }' \
  --output test-recording.mp4
```

If `test-recording.mp4` plays a ~10 second recording of example.com, the worker is working.

## Wiring into n8n (Browser Automation workflow)

Once deployed and smoke-tested, the n8n side is a straightforward HTTP Request node:

- Trigger: Execute Workflow Trigger, input `{ scriptId }`
- Get the row from `browser_timelines` (by `scriptId`) → its `timelineJson` column is the exact body to send
- HTTP Request node:
  - Method: POST
  - URL: `https://YOUR-WORKER-URL/record`
  - Headers: `X-Worker-Secret: YOUR_WORKER_SECRET` (store as an n8n credential, don't hardcode)
  - Body: raw JSON = the `timelineJson` value
  - Response format: File (binary) — the MP4 comes back directly in the response body
  - Timeout: set generously (e.g. 5x the video's `totalDurationSeconds` in ms, plus 30s buffer) since recording happens in real time
- Upload the resulting binary to a Google Drive staging folder, ready for Video Renderer (next worker) to combine with the Voice Agent audio

Ask me to build this n8n workflow once you've deployed and smoke-tested the worker —
I can wire and validate the n8n side immediately; I just can't deploy the worker itself
or verify the actual recording for you.

## Known limitations (by design, not bugs)

- **`target` matching is best-effort text search, not pixel-perfect.** Timeline AI never
  invents a CSS selector because it hasn't seen the real page — this worker searches
  visible text for keywords from `target` and scrolls/highlights the smallest matching
  element. Good enough for most content pages; won't handle heavily JS-rendered or
  canvas-based pages well.
- **Real-time pacing.** The worker sleeps between actions to match the timeline's
  `start`/`end` seconds, so a 75-second timeline takes ~75 real seconds to record.
  This is intentional (so the recording's pacing is genuinely synced), but means
  the worker is occupied for the full video duration per request.
- **One request at a time per instance** on free-tier hosting (single small container).
  Fine for the current low-volume use case; would need a queue for higher throughput.
