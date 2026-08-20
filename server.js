/**
 * Corrected /record handler for browser-automation-worker
 * -----------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * Symptom reported: the output video is a static screenshot being
 * zoomed/panned (Ken Burns effect), with no relation to the narration.
 * That is NOT what the n8n Timeline AI contract sends. It sends a real
 * action timeline synced to actual narration timing:
 *
 *   {
 *     schemaVersion: "1.0",
 *     scriptId, rowId, officialUrl, totalDurationSeconds, sceneCount,
 *     timeline: [
 *       { sceneId, start, end, officialUrl, action, target, highlight }
 *     ]
 *   }
 *
 *   action is one of: Open | Scroll | Click | Highlight | Wait
 *   target is a PLAIN-LANGUAGE description (never a CSS selector) —
 *   e.g. "tuition section", "Apply Now button".
 *
 * This handler actually navigates the live officialUrl in a real
 * Chromium page, performs each action for exactly (end - start) seconds
 * (so total video length always matches the narration/audio length),
 * and uses Playwright's native recordVideo to capture the real motion —
 * no screenshots, no fake zoom/pan.
 *
 * Drop this in as your /record route (replace whatever currently
 * generates the video). Keep everything else in your server.js
 * (express setup, x-worker-secret auth middleware, /health route, etc.)
 * as-is.
 * -----------------------------------------------------------------------
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { chromium } = require('playwright');
const { spawn } = require('child_process');

const router = express.Router();

// ---- Config -----------------------------------------------------------
// Keep these matching whatever your Railway plan's RAM budget is.
// 720x1280 (portrait) is the low-memory setting from earlier deploys;
// change via env vars without touching code.
const VIDEO_WIDTH = parseInt(process.env.VIDEO_WIDTH || '720', 10);
const VIDEO_HEIGHT = parseInt(process.env.VIDEO_HEIGHT || '1280', 10);

// Low-memory Chromium args. Deliberately NOT using --single-process —
// that flag was the earlier root cause of the black-screen bug
// (Chromium runs but never paints the page).
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

// ---- Helpers ------------------------------------------------------------

/**
 * Best-effort locator for a plain-language target description.
 * Tries role-based matches first (link/button - most "Apply Now" /
 * "tuition section" style targets are one of these or a heading),
 * then falls back to a case-insensitive text search anywhere on the page.
 * Returns a Playwright Locator or null if nothing visible was found.
 */
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

/** Draws a temporary highlight box around an element for `ms` milliseconds. */
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

/** Smoothly scrolls the page toward an element over `ms` milliseconds. */
async function smoothScrollTo(page, locator, ms) {
  const box = await locator.boundingBox().catch(() => null);
  if (!box) {
    // Fall back: scroll down by one viewport height smoothly.
    await smoothScrollBy(page, VIDEO_HEIGHT * 0.8, ms);
    return;
  }
  const targetY = await page.evaluate(
    ({ top, currentScroll, viewportH }) => currentScroll + top - viewportH * 0.25,
    { top: box.y, currentScroll: await page.evaluate(() => window.scrollY), viewportH: VIDEO_HEIGHT }
  );
  const startY = await page.evaluate(() => window.scrollY);
  await smoothScrollBy(page, targetY - startY, ms);
}

/** Scrolls by `deltaY` pixels smoothly over `ms` milliseconds, in small steps
 *  (this is what makes the recording look like a real person scrolling,
 *  not an instant jump-cut). */
async function smoothScrollBy(page, deltaY, ms) {
  const steps = Math.max(8, Math.min(60, Math.round(ms / 60)));
  const stepDelay = Math.max(16, Math.floor(ms / steps));
  const stepDelta = deltaY / steps;
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, stepDelta).catch(async () => {
      // mouse.wheel not supported in some contexts - fall back to JS scroll
      await page.evaluate((dy) => window.scrollBy(0, dy), stepDelta).catch(() => {});
    });
    await page.waitForTimeout(stepDelay);
  }
}

/** Runs one timeline entry for exactly its allotted duration. */
async function runScene(page, scene, remainingMs) {
  const start = Date.now();
  const budget = Math.max(300, remainingMs);

  try {
    switch (scene.action) {
      case 'Open': {
        // Already navigated before the loop starts; just let the page settle.
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
      default: {
        // Genuinely idle - narration is describing something already
        // visible, so don't move the page.
        break;
      }
    }
  } catch (err) {
    console.warn(`Scene ${scene.sceneId} (${scene.action} -> "${scene.target}") failed:`, err.message);
  }

  // Pad out the remainder of this scene's exact duration so total
  // video length always matches total narration length precisely.
  const elapsed = Date.now() - start;
  const pad = budget - elapsed;
  if (pad > 0) await page.waitForTimeout(pad);
}

/**
 * Converts Playwright's .webm output to .mp4 via ffmpeg (already present
 * in the Playwright Railway image). Downstream steps (Google Drive Check
 * folder, Cloudinary merge) name/expect .mp4 - sending .webm with a .mp4
 * name would produce a file that some players/APIs mishandle.
 */
function convertToMp4(webmPath, mp4Path) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-y',
      '-i', webmPath,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-pix_fmt', 'yuv420p',
      '-an', // this stage is video-only; audio is merged later via Cloudinary
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

// ---- Route --------------------------------------------------------------

router.post('/record', async (req, res) => {
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

    // Sort scenes by start time to guarantee playback order.
    const timeline = [...contract.timeline].sort((a, b) => a.start - b.start);

    const navStart = Date.now();
    await page.goto(contract.officialUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((err) => {
      console.warn('Navigation warning:', err.message);
    });
    const navElapsed = Date.now() - navStart;

    for (let i = 0; i < timeline.length; i++) {
      const scene = timeline[i];
      const sceneDurationMs = Math.max(300, (scene.end - scene.start) * 1000);
      // For the very first scene (Open), subtract time already spent
      // navigating so total timing still lines up with the narration.
      const budget = i === 0 ? Math.max(300, sceneDurationMs - navElapsed) : sceneDurationMs;
      await runScene(page, scene, budget);
    }

    await context.close(); // flushes the recorded video file to videoDir
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

module.exports = router;

