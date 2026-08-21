/**
 * server.js — browser-automation-worker
 * -----------------------------------------------------------------------
 * This is the FULL, deployable entrypoint. The previous file you pasted
 * (record-handler-fix.js) was only the /record router — it had no
 * express() app and no app.listen(...), so when it was deployed as
 * server.js directly, the Node process loaded the module and then just
 * exited (nothing kept the event loop alive / nothing bound to a port).
 * That's exactly why Railway logs showed "Starting Container" and then
 * nothing else, and every request got a 502 after ~15s (Railway's edge
 * waiting for a port that was never opened).
 *
 * This file fixes that by actually creating the Express app, wiring auth
 * + health check, mounting the /record route, and calling app.listen()
 * on Railway's PORT.
 *
 * NOTE: this restores the /record logic from your pasted file as-is
 * (real Playwright navigation + scroll/click/highlight timing, native
 * video recording, ffmpeg webm->mp4 conversion). It does NOT include the
 * later zoom-in/zoom-out camera effect or the tryHideCookieBannerV3 fix
 * you added in a previous session — those aren't in the file you pasted,
 * so I can't reconstruct their exact code. If you still want them, paste
 * that version of the file (or tell me and I'll re-add the cookie-banner
 * V3 fix using the description we have on record) and I'll merge it in.
 * For now, this gets the server actually running again so we can confirm
 * the pipeline end-to-end, then layer those improvements back on.
 * -----------------------------------------------------------------------
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { chromium } = require('playwright');
const { spawn } = require('child_process');

const app = express();
app.use(express.json({ limit: '5mb' }));

const PORT = process.env.PORT || 8080;
const WORKER_SECRET = process.env.WORKER_SECRET;

// ---- Config -------------------------------------------------------------
const VIDEO_WIDTH = parseInt(process.env.VIDEO_WIDTH || '1280', 10);
const VIDEO_HEIGHT = parseInt(process.env.VIDEO_HEIGHT || '720', 10);

const LAUNCH_ARGS = [
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--disable-setuid-sandbox',
  '--no-sandbox',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-default-apps',
  '--mute-audio',
];

// ---- Helpers --------------------------------------------------------------

async function findTarget(page, target) {
  if (!target || typeof target !== 'string') return null;
  const pattern = new RegExp(escapeRegex(target), 'i');

  const candidates = [
    () => page.getByRole('link', { name: pattern }),
    () => page.getByRole('button', { name: pattern }),
    () => page.getByRole('heading', { name: pattern }),
    () => page.getByText(pattern),
  ];

  for (const getLocator of candidates) {
    try {
      const locator = getLocator().first();
      const count = await locator.count();
      if (count > 0 && (await locator.isVisible().catch(() => false))) {
        return locator;
      }
    } catch (_) {
      // try next strategy
    }
  }
  return null;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function highlightElement(page, locator, ms) {
  try {
    await locator.evaluate((el) => {
      el.setAttribute('data-worker-highlight', 'true');
      el.style.outline = '4px solid #ff3b30';
      el.style.outlineOffset = '3px';
      el.style.transition = 'outline-color 0.2s ease';
      el.style.boxShadow = '0 0 0 6px rgba(255,59,48,0.25)';
    });
    await page.waitForTimeout(ms);
  } finally {
    await locator
      .evaluate((el) => {
        el.style.outline = '';
        el.style.outlineOffset = '';
        el.style.boxShadow = '';
        el.removeAttribute('data-worker-highlight');
      })
      .catch(() => {});
  }
}

async function smoothScrollTo(page, locator, ms) {
  const box = await locator.boundingBox().catch(() => null);
  if (!box) {
    await smoothScrollBy(page, VIDEO_HEIGHT * 0.8, ms);
    return;
  }
  const currentScroll = await page.evaluate(() => window.scrollY);
  const targetY = currentScroll + box.y - VIDEO_HEIGHT * 0.25;
  const startY = currentScroll;
  await smoothScrollBy(page, targetY - startY, ms);
}

async function smoothScrollBy(page, deltaY, ms) {
  const steps = Math.max(8, Math.min(60, Math.round(ms / 60)));
  const stepDelay = Math.max(16, Math.floor(ms / steps));
  const stepDelta = deltaY / steps;
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, stepDelta).catch(async () => {
      await page.evaluate((dy) => window.scrollBy(0, dy), stepDelta).catch(() => {});
    });
    await page.waitForTimeout(stepDelay);
  }
}

async function runScene(page, scene, remainingMs) {
  const start = Date.now();
  const budget = Math.max(300, remainingMs);

  try {
    switch (scene.action) {
      case 'Open': {
        await page.waitForTimeout(Math.min(800, budget));
        break;
      }
      case 'Scroll': {
        const locator = await findTarget(page, scene.target);
        const scrollBudget = Math.floor(budget * 0.6);
        if (locator) {
          await smoothScrollTo(page, locator, scrollBudget);
          if (scene.highlight) {
            await highlightElement(page, locator, budget - scrollBudget);
          }
        } else {
          await smoothScrollBy(page, VIDEO_HEIGHT * 0.7, scrollBudget);
        }
        break;
      }
      case 'Click': {
        const locator = await findTarget(page, scene.target);
        if (locator) {
          await smoothScrollTo(page, locator, Math.floor(budget * 0.4));
          if (scene.highlight) {
            await highlightElement(page, locator, Math.floor(budget * 0.3));
          }
          await locator.click({ trial: false, timeout: 3000 }).catch(() => {});
        }
        break;
      }
      case 'Highlight': {
        const locator = await findTarget(page, scene.target);
        if (locator) {
          await smoothScrollTo(page, locator, Math.floor(budget * 0.4));
          await highlightElement(page, locator, budget - Math.floor(budget * 0.4));
        }
        break;
      }
      case 'Wait':
      default:
        break;
    }
  } catch (err) {
    console.warn(`Scene ${scene.sceneId} (${scene.action} -> "${scene.target}") failed:`, err.message);
  }

  const elapsed = Date.now() - start;
  const pad = budget - elapsed;
  if (pad > 0) await page.waitForTimeout(pad);
}

function convertToMp4(webmPath, mp4Path) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-y',
      '-i', webmPath,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-pix_fmt', 'yuv420p',
      '-an',
      mp4Path,
    ]);
    let stderr = '';
    ff.stderr.on('data', (d) => { stderr += d.toString(); });
    ff.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-500)}`));
    });
  });
}

// ---- Auth middleware ------------------------------------------------------
function requireWorkerSecret(req, res, next) {
  if (!WORKER_SECRET) {
    console.warn('WARNING: WORKER_SECRET env var not set — /record is unauthenticated');
    return next();
  }
  if (req.get('x-worker-secret') !== WORKER_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ---- Routes ---------------------------------------------------------------

app.get('/health', (req, res) => {
  res.json({ status: 'ok', resolution: `${VIDEO_WIDTH}x${VIDEO_HEIGHT}` });
});

app.post('/record', requireWorkerSecret, async (req, res) => {
  const contract = req.body;
  if (!contract || !Array.isArray(contract.timeline) || !contract.officialUrl) {
    return res.status(400).json({ error: 'Invalid timeline contract: missing officialUrl or timeline[]' });
  }

  const videoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));
  let browser;

  try {
    browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
    const context = await browser.newContext({
      viewport: { width: VIDEO_WIDTH, height: VIDEO_HEIGHT },
      recordVideo: { dir: videoDir, size: { width: VIDEO_WIDTH, height: VIDEO_HEIGHT } },
    });
    const page = await context.newPage();

    const timeline = [...contract.timeline].sort((a, b) => a.start - b.start);

    const navStart = Date.now();
    await page.goto(contract.officialUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((err) => {
      console.warn('Navigation warning:', err.message);
    });
    const navElapsed = Date.now() - navStart;

    for (let i = 0; i < timeline.length; i++) {
      const scene = timeline[i];
      const sceneDurationMs = Math.max(300, (scene.end - scene.start) * 1000);
      const budget = i === 0 ? Math.max(300, sceneDurationMs - navElapsed) : sceneDurationMs;
      await runScene(page, scene, budget);
    }

    await context.close();
    await browser.close();
    browser = null;

    const files = fs.readdirSync(videoDir).filter((f) => f.endsWith('.webm'));
    if (!files.length) {
      throw new Error('Recording finished but no video file was produced');
    }
    const webmPath = path.join(videoDir, files[0]);
    const mp4Path = path.join(videoDir, 'recording.mp4');
    await convertToMp4(webmPath, mp4Path);

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', 'attachment; filename="recording.mp4"');
    const stream = fs.createReadStream(mp4Path);
    stream.pipe(res);
    stream.on('close', () => {
      fs.rm(videoDir, { recursive: true, force: true }, () => {});
    });
  } catch (err) {
    console.error('Recording failed:', err);
    if (browser) await browser.close().catch(() => {});
    fs.rm(videoDir, { recursive: true, force: true }, () => {});
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log(`Recording resolution: ${VIDEO_WIDTH}x${VIDEO_HEIGHT}`);
});
