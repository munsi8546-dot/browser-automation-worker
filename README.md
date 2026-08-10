# Amin AI — Browser Automation Worker

Playwright-based screen recording worker for the Amin AI Global Opportunity Platform. Consumes a "Browser Automation Contract v1" produced by Timeline AI, plays back actions against official university/program pages, records the screen in vertical 9:16 format, and returns an MP4 video binary.

---

## What It Does

- **`GET /health`**: Health check endpoint returning worker status and supported schema major version.
- **`POST /record`**: 
  1. Receives a Timeline AI v1 JSON payload.
  2. Opens the target official URL in headless Chromium (1080x1920 vertical format).
  3. Executes timeline actions (Open, Scroll, Highlight) in real-time.
  4. Records the browser session using Playwright.
  5. Converts recording to MP4 using `ffmpeg`.
  6. Returns the binary MP4 directly in the HTTP response.

---

## Contract Format (schemaVersion "1.0")

```json
{
  "schemaVersion": "1.0",
  "scriptId": 1,
  "rowId": 2,
  "officialUrl": "https://www.unibo.it",
  "totalDurationSeconds": 75,
  "sceneCount": 5,
  "timeline": [
    { 
      "sceneId": 1, 
      "start": 0, 
      "end": 15, 
      "officialUrl": "https://www.unibo.it", 
      "action": "Open", 
      "target": "official program page", 
      "highlight": true 
    }
  ]
}
