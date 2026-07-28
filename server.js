'use strict';

/**
 * Amin AI Global Opportunity Platform — Browser Automation Worker
 *
 * Consumes the "Browser Automation Contract v1" produced by the Timeline AI
 * n8n workflow, plays it back against the real official page with Playwright,
 * records the screen, and returns the resulting MP4.
 *
 * Contract (schemaVersion "1.0"):
 * {
 *   "schemaVersion": "1.0",
 *   "scriptId": 1,
 *   "rowId": 2,
 *   "officialUrl": "https://...",
 *   "totalDurationSeconds": 75,
 *   "sceneCount": 5,
 *   "timeline": [
 *     { "sceneId": 1, "start": 0, "end": 6, "officialUrl": "...", "action": "Open", "target": "official program page", "highlight": true },
 *     ...
 *   ]
 * }
 *
 * VERSIONING RULE (must stay true for this worker to remain stable):
 * - This worker only understands major version "1". Any schemaVersion starting
 *   with "1." (e.g. "1.0", "1.1") is accepted - new OPTIONAL fields may appear
 *   and are simply ignored by this worker without needing a code change.
 * - A schemaVersion starting with "2." or higher is REJECTED with a clear 409
 *   error rather than guessed at. That is the signal a new worker version is
 *   needed - never silently attempt to interpret an incompatible contract.
 *
 * SECURITY: this endpoint is a public webhook once deployed. It requires a
 * shared-secret header (see WORKER_SECRET below) - set this in your hosting
 * provider's environment variables, and put the same value in n8n's HTTP
 * Request node as a header. Do not deploy without setting a real secret.
 */

const express = require('express');
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const app = express();
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 8080;
const WORKER_SECRET = process.env.WORKER_SECRET || '';
const SUPPORTED_MAJOR_VERSION = '1';

// Viewport / recording size — vertical, matches the rest of the platform's short-form format.
const RECORDING_WIDTH = 1080;
const RECORDING_HEIGHT = 1920;

// Safety ceiling so a bad request can't tie up the worker (and its free-tier hosting) indefinitely.
const MAX_TOTAL_DURATION_SECONDS = 180;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Best-effort "scroll to / highlight the thing described in plain language" helper.
 * Timeline AI deliberately never invents CSS selectors (it hasn't seen the real page),
 * so `target` is a human description like "tuition section" or "Apply Now button".
 * This does a simple case-insensitive text search across visible elements and
 * scrolls the best match into view. It is intentionally approximate - if nothing
 * matches, it just scrolls down proportionally instead of failing the whole recording.
 */
async function findAndScrollToText(page, targetText) {
  const keywords = String(targetText || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 6);

  if (keywords.length === 0) return { found: false };

  const result = await page.evaluate((kws) => {
    function visible(el) {
      const r = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    }

    const candidates = Array.from(document.querySelectorAll('body *')).filter((el) => {
      if (!visible(el)) return false;
      const text = (el.textContent || '').trim().toLowerCase();
      if (!text || text.length > 300) return false;
      return kws.some((k) => text.includes(k));
    });

    if (candidates.length === 0) return { found: false };

    // Prefer the smallest matching element (most specific), not a huge wrapping <div>.
    candidates.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return ra.width * ra.height - rb.width * rb.height;
    });

    const el = candidates[0];
    el.scrollIntoView({ behavior: 'instant', block: 'center' });

    const rect = el.getBoundingClientRect();
    return { found: true, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
  }, keywords);

  return result;
}

async function drawHighlightBox(page, rect) {
  if (!rect) return;
  await page.evaluate((r) => {
    const box = document.createElement('div');
    box.setAttribute('data-amin-highlight', 'true');
    box.style.position = 'fixed';
    box.style.left = r.x - 8 + 'px';
    box.style.top = r.y - 8 + 'px';
    box.style.width = r.width + 16 + 'px';
    box.style.height = r.height + 16 + 'px';
    box.style.border = '4px solid #ffcc00';
    box.style.borderRadius = '8px';
    box.style.boxShadow = '0 0 0 4000px rgba(0,0,0,0.35)';
    box.style.zIndex = '2147483647';
    box.style.pointerEvents = 'none';
    box.style.transition = 'opacity 0.2s ease-in';
    document.body.appendChild(box);
  }, rect);
}

async function clearHighlightBoxes(page) {
  await page.evaluate(() => {
    document.querySelectorAll('[data-amin-highlight]').forEach((el) => el.remove());
  });
}

async function tryClickText(page, targetText) {
  const keywords = String(targetText || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 6);

  const clicked = await page.evaluate((kws) => {
    const clickable = Array.from(document.querySelectorAll('a, button, [role="button"]'));
    const match = clickable.find((el) => {
      const text = (el.textContent || '').trim().toLowerCase();
      return text && kws.some((k) => text.includes(k));
    });
    if (match) {
      match.scrollIntoView({ behavior: 'instant', block: 'center' });
      return true;
    }
    return false;
  }, keywords);

  if (clicked) {
    try {
      await page.click(
        `a:has-text("${keywords[0] || ''}"), button:has-text("${keywords[0] || ''}")`,
        { timeout: 3000 }
      );
      return true;
    } catch (e) {
      // Click attempt failed (e.g. overlay, navigation) - fall through to highlight-only.
      return false;
    }
  }
  return false;
}

async function runTimeline(officialUrl, timeline, totalDurationSeconds, outputDir) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: RECORDING_WIDTH, height: RECORDING_HEIGHT },
    recordVideo: { dir: outputDir, size: { width: RECORDING_WIDTH, height: RECORDING_HEIGHT } }
  });
  const page = await context.newPage();

  const startedAt = Date.now();

  try {
    for (const entry of timeline) {
      // Real-time pacing so the recording's wall-clock timing matches the scene's start second.
      const targetElapsedMs = Math.max(0, entry.start * 1000);
      const actualElapsedMs = Date.now() - startedAt;
      if (targetElapsedMs > actualElapsedMs) {
        await sleep(targetElapsedMs - actualElapsedMs);
      }

      switch (entry.action) {
        case 'Open': {
          await page.goto(entry.officialUrl || officialUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          break;
        }
        case 'Scroll': {
          await clearHighlightBoxes(page);
          await findAndScrollToText(page, entry.target);
          break;
        }
        case 'Highlight': {
          await clearHighlightBoxes(page);
          const result = await findAndScrollToText(page, entry.target);
          if (result.found) await drawHighlightBox(page, result.rect);
          break;
        }
        case 'Click': {
          await clearHighlightBoxes(page);
          const clicked = await tryClickText(page, entry.target);
          if (!clicked) {
            // Graceful fallback: couldn't confidently click anything - highlight instead
            // rather than risk clicking the wrong element or throwing.
            const result = await findAndScrollToText(page, entry.target);
            if (result.found) await drawHighlightBox(page, result.rect);
          }
          break;
        }
        case 'Wait': {
          // Nothing to do - the pacing sleep above already covers this.
          break;
        }
        case 'Close': {
          // Handled by context.close() after the loop; nothing to do mid-timeline.
          break;
        }
        default: {
          console.warn(`Unknown action "${entry.action}" for sceneId ${entry.sceneId} - skipping.`);
        }
      }

      // Hold this scene's state until its "end" time so the recording isn't rushed.
      const holdUntilMs = Math.max(0, entry.end * 1000);
      const elapsedNow = Date.now() - startedAt;
      if (holdUntilMs > elapsedNow) {
        await sleep(holdUntilMs - elapsedNow);
      }
    }

    // Cover any tail time if totalDurationSeconds extends past the last timeline entry.
    const tailMs = Math.max(0, totalDurationSeconds * 1000 - (Date.now() - startedAt));
    if (tailMs > 0) await sleep(tailMs);
  } finally {
    await page.close();
  }

  const videoPath = await page.video().path();
  await context.close();
  await browser.close();

  return videoPath;
}

/**
 * Playwright's built-in recorder only outputs .webm, but the platform's contract
 * (per the original architecture: "Playwright Worker → MP4 → Return Video") expects
 * MP4. Converts using the ffmpeg CLI, which must be present in the deployment image
 * (see Dockerfile - installed via apt-get alongside Playwright's own dependencies).
 */
function webmToMp4(webmPath) {
  return new Promise((resolve, reject) => {
    const mp4Path = webmPath.replace(/\.webm$/, '.mp4');
    const ffmpeg = spawn('ffmpeg', [
      '-y',
      '-i', webmPath,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '23',
      '-pix_fmt', 'yuv420p',
      mp4Path
    ]);

    let stderr = '';
    ffmpeg.stderr.on('data', (d) => { stderr += d.toString(); });
    ffmpeg.on('error', (err) => reject(new Error(`Failed to start ffmpeg (is it installed in this image?): ${err.message}`)));
    ffmpeg.on('close', (code) => {
      if (code === 0 && fs.existsSync(mp4Path)) {
        resolve(mp4Path);
      } else {
        reject(new Error(`ffmpeg exited with code ${code}. stderr: ${stderr.slice(-1000)}`));
      }
    });
  });
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', supportedSchemaMajorVersion: SUPPORTED_MAJOR_VERSION });
});

app.post('/record', async (req, res) => {
  // --- Auth ---
  if (!WORKER_SECRET) {
    return res.status(500).json({ error: 'Worker misconfigured: WORKER_SECRET is not set on the server.' });
  }
  const providedSecret = req.get('x-worker-secret') || '';
  if (providedSecret !== WORKER_SECRET) {
    return res.status(401).json({ error: 'Unauthorized - missing or incorrect X-Worker-Secret header.' });
  }

  const body = req.body || {};
  const { schemaVersion, officialUrl, totalDurationSeconds, timeline } = body;

  // --- Contract validation ---
  if (!schemaVersion || typeof schemaVersion !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid "schemaVersion" field.' });
  }
  const majorVersion = schemaVersion.split('.')[0];
  if (majorVersion !== SUPPORTED_MAJOR_VERSION) {
    return res.status(409).json({
      error: `Unsupported contract version "${schemaVersion}". This worker only supports major version ${SUPPORTED_MAJOR_VERSION}.x. A breaking Timeline AI change was introduced without updating this worker - update the worker, don't force it.`
    });
  }
  if (!officialUrl || typeof officialUrl !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid "officialUrl" field.' });
  }
  if (!Array.isArray(timeline) || timeline.length === 0) {
    return res.status(400).json({ error: 'Missing or empty "timeline" array.' });
  }
  const duration = Number(totalDurationSeconds) || timeline[timeline.length - 1].end || 30;
  if (duration > MAX_TOTAL_DURATION_SECONDS) {
    return res.status(400).json({ error: `totalDurationSeconds (${duration}) exceeds the ${MAX_TOTAL_DURATION_SECONDS}s safety ceiling.` });
  }

  const outputDir = path.join(os.tmpdir(), `amin-recording-${crypto.randomUUID()}`);
  fs.mkdirSync(outputDir, { recursive: true });

  try {
    const webmPath = await runTimeline(officialUrl, timeline, duration, outputDir);
    const mp4Path = await webmToMp4(webmPath);
    const videoBuffer = fs.readFileSync(mp4Path);

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', 'attachment; filename="recording.mp4"');
    res.send(videoBuffer);
  } catch (err) {
    console.error('Recording failed:', err);
    res.status(500).json({ error: 'Recording failed', detail: String((err && err.message) || err) });
  } finally {
    fs.rm(outputDir, { recursive: true, force: true }, () => {});
  }
});

app.listen(PORT, () => {
  console.log(`Browser Automation Worker listening on port ${PORT}`);
  console.log(`Supports Timeline AI contract major version: ${SUPPORTED_MAJOR_VERSION}.x`);
  if (!WORKER_SECRET) {
    console.warn('WARNING: WORKER_SECRET is not set - /record will reject all requests until it is.');
  }
});
