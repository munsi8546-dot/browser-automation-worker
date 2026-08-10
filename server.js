'use strict';

/**
 * Amin AI Global Opportunity Platform — Browser Automation Worker
 * Playwright-based screen recording worker that consumes a Timeline AI JSON v1.0
 * and returns an MP4 video binary.
 */

const express = require('express');
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const app = express();
app.use(express.json({ limit: '5mb' }));

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

  return await page.evaluate((kws) => {
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
    document.body.appendChild(box);
  }, rect);
}

async function clearHighlightBoxes(page) {
  await page.evaluate(() => {
    document.querySelectorAll('[data-amin-highlight]').forEach((el) => el.remove());
  });
}

async function runTimeline(officialUrl, timeline, totalDurationSeconds, outputDir) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const context = await browser.newContext({
    viewport: { width: RECORDING_WIDTH, height: RECORDING_HEIGHT },
    recordVideo: { dir: outputDir, size: { width: RECORDING_WIDTH, height: RECORDING_HEIGHT } }
  });

  const page = await context.newPage();
  const startedAt = Date.now();

  try {
    const startUrl = officialUrl && officialUrl.startsWith('http') ? officialUrl : 'https://example.com';
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    if (Array.isArray(timeline)) {
      for (const entry of timeline) {
        const targetElapsedMs = Math.max(0, entry.start * 1000);
        const actualElapsedMs = Date.now() - startedAt;
        if (targetElapsedMs > actualElapsedMs) {
          await sleep(targetElapsedMs - actualElapsedMs);
        }

        switch (entry.action) {
          case 'Open':
            if (entry.officialUrl) await page.goto(entry.officialUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
            break;
          case 'Scroll':
            await clearHighlightBoxes(page);
            await findAndScrollToText(page, entry.target);
            break;
          case 'Highlight':
            await clearHighlightBoxes(page);
            const res = await findAndScrollToText(page, entry.target);
            if (res.found) await drawHighlightBox(page, res.rect);
            break;
        }

        const holdUntilMs = Math.max(0, entry.end * 1000);
        const elapsedNow = Date.now() - startedAt;
        if (holdUntilMs > elapsedNow) {
          await sleep(holdUntilMs - elapsedNow);
        }
      }
    } else {
      await sleep(5000);
    }
  } catch (err) {
    console.warn('Playback warning:', err.message);
  }

  const videoPage = page.video();
  await context.close();
  await browser.close();

  if (!videoPage) throw new Error('Video recording failed');
  return await videoPage.path();
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
        reject(new Error(`ffmpeg exited with code ${code}. stderr: ${stderr.slice(-500)}`));
      }
    });
  });
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'browser-automation-worker', supportedSchemaMajorVersion: SUPPORTED_MAJOR_VERSION });
});

app.post('/record', async (req, res) => {
  if (WORKER_SECRET && (req.get('x-worker-secret') || '') !== WORKER_SECRET) {
    return res.status(401).json({ error: 'Unauthorized - incorrect X-Worker-Secret header.' });
  }

  const body = req.body || {};
  const { schemaVersion, officialUrl, totalDurationSeconds, timeline } = body;

  if (!schemaVersion || typeof schemaVersion !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid "schemaVersion" field.' });
  }

  const majorVersion = schemaVersion.split('.')[0];
  if (majorVersion !== SUPPORTED_MAJOR_VERSION) {
    return res.status(409).json({ error: `Unsupported contract version "${schemaVersion}".` });
  }

  const duration = Number(totalDurationSeconds) || 30;
  if (duration > MAX_TOTAL_DURATION_SECONDS) {
    return res.status(400).json({ error: `totalDurationSeconds exceeds ceiling.` });
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
    res.status(500).json({ error: 'Recording failed', detail: String(err.message || err) });
  } finally {
    fs.rm(outputDir, { recursive: true, force: true }, () => {});
  }
});

app.listen(PORT, () => {
  console.log(`Browser Automation Worker active on port ${PORT}`);
});
