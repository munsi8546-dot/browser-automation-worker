'use strict';

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

const RECORDING_WIDTH = 1080;
const RECORDING_HEIGHT = 1920;

const MAX_TOTAL_DURATION_SECONDS = 180;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
      return false;
    }
  }
  return false;
}

async function runTimeline(officialUrl, timeline, totalDurationSeconds, outputDir) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-sync',
      '--disable-translate',
      '--no-first-run'
    ]
  });
  const context = await browser.newContext({
    viewport: { width: RECORDING_WIDTH, height: RECORDING_HEIGHT },
    recordVideo: { dir: outputDir, size: { width: RECORDING_WIDTH, height: RECORDING_HEIGHT } }
  });
  const page = await context.newPage();

  const startedAt = Date.now();

  try {
    for (const entry of timeline) {
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
            const result = await findAndScrollToText(page, entry.target);
            if (result.found) await drawHighlightBox(page, result.rect);
          }
          break;
        }
        case 'Wait': {
          break;
        }
        case 'Close': {
          break;
        }
        default: {
          console.warn(`Unknown action "${entry.action}" for sceneId ${entry.sceneId} - skipping.`);
        }
      }

      const holdUntilMs = Math.max(0, entry.end * 1000);
      const elapsedNow = Date.now() - startedAt;
      if (holdUntilMs > elapsedNow) {
        await sleep(holdUntilMs - elapsedNow);
      }
    }

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
    ffmpeg.on('error', (err) => reject(new Error(`Failed to start ffmpeg: ${err.message}`)));
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
  if (!WORKER_SECRET) {
    return res.status(500).json({ error: 'Worker misconfigured: WORKER_SECRET is not set on the server.' });
  }
  const providedSecret = req.get('x-worker-secret') || '';
  if (providedSecret !== WORKER_SECRET) {
    return res.status(401).json({ error: 'Unauthorized - missing or incorrect X-Worker-Secret header.' });
  }

  const body = req.body || {};
  const { schemaVersion, officialUrl, totalDurationSeconds, timeline } = body;

  if (!schemaVersion || typeof schemaVersion !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid "schemaVersion" field.' });
  }
  const majorVersion = schemaVersion.split('.')[0];
  if (majorVersion !== SUPPORTED_MAJOR_VERSION) {
    return res.status(409).json({
      error: `Unsupported contract version "${schemaVersion}". This worker only supports major version ${SUPPORTED_MAJOR_VERSION}.x.`
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
  console.log(`Recording resolution: ${RECORDING_WIDTH}x${RECORDING_HEIGHT}`);
  if (!WORKER_SECRET) {
    console.warn('WARNING: WORKER_SECRET is not set - /record will reject all requests until it is.');
  }
});
