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

const RECORDING_WIDTH = 1280;
const RECORDING_HEIGHT = 720;

const MAX_TOTAL_DURATION_SECONDS = 180;
const DEBUG_SCREENSHOT_TIMEOUT_SECONDS = 45;

function sleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

async function findAndScrollToText(page, targetText) {
  var keywords = String(targetText || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(function(w) { return w.length > 3; })
    .slice(0, 6);

  if (keywords.length === 0) return { found: false };

  var result = await page.evaluate(function(kws) {
    function visible(el) {
      var r = el.getBoundingClientRect();
      var style = window.getComputedStyle(el);
      return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    }

    var candidates = Array.from(document.querySelectorAll('body *')).filter(function(el) {
      if (!visible(el)) return false;
      var text = (el.textContent || '').trim().toLowerCase();
      if (!text || text.length > 300) return false;
      return kws.some(function(k) { return text.includes(k); });
    });

    if (candidates.length === 0) return { found: false };

    candidates.sort(function(a, b) {
      var ra = a.getBoundingClientRect();
      var rb = b.getBoundingClientRect();
      return ra.width * ra.height - rb.width * rb.height;
    });

    var el = candidates[0];
    el.scrollIntoView({ behavior: 'instant', block: 'center' });

    var rect = el.getBoundingClientRect();
    return { found: true, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
  }, keywords);

  return result;
}

async function drawHighlightBox(page, rect) {
  if (!rect) return;
  await page.evaluate(function(r) {
    var box = document.createElement('div');
    box.setAttribute('data-amin-highlight', 'true');
    box.style.position = 'fixed';
    box.style.left = (r.x - 8) + 'px';
    box.style.top = (r.y - 8) + 'px';
    box.style.width = (r.width + 16) + 'px';
    box.style.height = (r.height + 16) + 'px';
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
  await page.evaluate(function() {
    document.querySelectorAll('[data-amin-highlight]').forEach(function(el) { el.remove(); });
  });
}

async function tryClickText(page, targetText) {
  var keywords = String(targetText || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(function(w) { return w.length > 3; })
    .slice(0, 6);

  var clicked = await page.evaluate(function(kws) {
    var clickable = Array.from(document.querySelectorAll('a, button, [role="button"]'));
    var match = clickable.find(function(el) {
      var text = (el.textContent || '').trim().toLowerCase();
      return text && kws.some(function(k) { return text.includes(k); });
    });
    if (match) {
      match.scrollIntoView({ behavior: 'instant', block: 'center' });
      return true;
    }
    return false;
  }, keywords);

  if (clicked) {
    try {
      var selector = 'a:has-text("' + (keywords[0] || '') + '"), button:has-text("' + (keywords[0] || '') + '")';
      await page.click(selector, { timeout: 3000 });
      return true;
    } catch (e) {
      return false;
    }
  }
  return false;
}

// --- Zoom-pan camera effect (professional/documentary feel) ---
// Applies a CSS transform (scale + translate) to document.body so the
// highlighted element appears to be smoothly zoomed into, like a camera
// push-in. Because /record uses Playwright's native context.recordVideo
// (real-time compositor capture, not a screenshot loop), this transition
// is captured live in the output video for free -- no extra frame handling
// needed. zoomOut() reverses it. Both are no-ops-safe: if called when
// already in the target state they just re-apply the same transform.
async function zoomToRect(page, rect, opts) {
  if (!rect) return;
  var scale = (opts && opts.scale) || 1.6;
  var durationMs = (opts && opts.durationMs) || 1200;

  await page.evaluate(function(args) {
    var r = args.rect;
    var scale = args.scale;
    var durationMs = args.durationMs;

    var cx = r.x + r.width / 2;
    var cy = r.y + r.height / 2;
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var tx = (vw / 2 - cx) * scale;
    var ty = (vh / 2 - cy) * scale;

    document.body.style.transition = 'transform ' + durationMs + 'ms ease-in-out';
    document.body.style.transformOrigin = 'center center';
    document.body.style.transform = 'translate(' + tx + 'px, ' + ty + 'px) scale(' + scale + ')';
  }, { rect: rect, scale: scale, durationMs: durationMs });

  await sleep(durationMs);
}

async function zoomOut(page, opts) {
  var durationMs = (opts && opts.durationMs) || 1000;

  await page.evaluate(function(durationMs) {
    document.body.style.transition = 'transform ' + durationMs + 'ms ease-in-out';
    document.body.style.transform = 'translate(0px, 0px) scale(1)';
  }, durationMs);

  await sleep(durationMs);
}

// --- Cookie banner suppression (Issue A fix, v3 -- diagnostic candidate) ---
// v2 (tryHideCookieBanner above) still uses page.evaluate() to walk up to 6
// ancestors calling window.getComputedStyle() at each step, then directly
// sets style.display on the found container. Confirmed (commit 29f1ccb3)
// that this STILL produced a 100% black recordVideo output, even though it
// never clicks or navigates. v3 minimizes what evaluate() does: it only
// marks the container with a data-attribute (one cheap DOM write, no
// getComputedStyle loop), then hides it via page.addStyleTag() -- a
// separate Playwright-level CSS injection call, not further JS evaluation.
// This isolates whether the getComputedStyle-walking loop itself was the
// problem, or whether any evaluate()-based mutation breaks the recording.
async function tryHideCookieBannerV3(page) {
  try {
    var marked = await page.evaluate(function() {
      var targetPhrase = 'accept only necessary cookies';
      var candidates = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]'));
      var match = candidates.find(function(el) {
        var text = (el.innerText || el.textContent || el.value || '').trim().toLowerCase();
        return text.indexOf(targetPhrase) !== -1;
      });
      if (!match) return false;

      // Walk up to the nearest fixed/sticky-positioned ancestor -- that's
      // reliably the full banner box, not just a wrapper around one button.
      var container = match;
      var el = match;
      for (var i = 0; i < 6 && el; i++) {
        var style = window.getComputedStyle(el);
        if (style.position === 'fixed' || style.position === 'sticky') {
          container = el;
          break;
        }
        el = el.parentElement;
        if (el) container = el;
      }
      container.setAttribute('data-amin-cookie-banner', 'true');
      return true;
    });

    if (marked) {
      await page.addStyleTag({ content: '[data-amin-cookie-banner="true"] { display: none !important; }' });
    }
  } catch (e) {
    // No banner present, or marking/hiding failed for an unrelated reason --
    // ignore and continue. Never let this break /record.
  }
}

// v2 (kept for now, currently unused by runTimeline -- still under test)
// caused the recorded video to go 100% black (confirmed via /debug-screenshot
// + Railway logs: page renders fine with no click; recording pipeline threw
// no errors yet produced black frames the moment the click was added --
// almost certainly the site's consent script disrupting the page/compositor
// on click). To avoid that risk entirely, this version never simulates a
// click or triggers any consent-script side effects. It just walks up from
// the matched button to the nearest fixed/sticky-positioned ancestor (the
// banner container) and hides it with display:none. No navigation, no JS
// handlers fired, nothing for the recording pipeline to trip over.
async function tryHideCookieBanner(page) {
  try {
    await page.evaluate(function() {
      var targetPhrase = 'accept only necessary cookies';
      var candidates = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]'));
      var match = candidates.find(function(el) {
        var text = (el.innerText || el.textContent || el.value || '').trim().toLowerCase();
        return text.indexOf(targetPhrase) !== -1;
      });
      if (!match) return false;

      var container = match;
      var el = match;
      for (var i = 0; i < 6 && el; i++) {
        var style = window.getComputedStyle(el);
        if (style.position === 'fixed' || style.position === 'sticky') {
          container = el;
          break;
        }
        el = el.parentElement;
        if (el) container = el;
      }
      container.style.display = 'none';
      return true;
    });
  } catch (e) {
    // No banner present, or hide failed for an unrelated reason -- ignore
    // and continue with the timeline. Never let this break /record.
  }
}

async function runTimeline(officialUrl, timeline, totalDurationSeconds, outputDir) {
  var browser = await chromium.launch({
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
  var context = await browser.newContext({
    viewport: { width: RECORDING_WIDTH, height: RECORDING_HEIGHT },
    recordVideo: { dir: outputDir, size: { width: RECORDING_WIDTH, height: RECORDING_HEIGHT } }
  });
  var page = await context.newPage();

  var startedAt = Date.now();
  // Tracks whether the page is currently zoomed in on a Highlight target,
  // so any subsequent non-Highlight action (or the end of the timeline)
  // smoothly zooms back out first instead of jumping/cutting.
  var isZoomedIn = false;

  try {
    for (var i = 0; i < timeline.length; i++) {
      var entry = timeline[i];
      var targetElapsedMs = Math.max(0, entry.start * 1000);
      var actualElapsedMs = Date.now() - startedAt;
      if (targetElapsedMs > actualElapsedMs) {
        await sleep(targetElapsedMs - actualElapsedMs);
      }

      switch (entry.action) {
        case 'Open':
          if (isZoomedIn) { await zoomOut(page); isZoomedIn = false; }
          await page.goto(entry.officialUrl || officialUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await tryHideCookieBannerV3(page);
          break;
        case 'Scroll':
          if (isZoomedIn) { await zoomOut(page); isZoomedIn = false; }
          await clearHighlightBoxes(page);
          await findAndScrollToText(page, entry.target);
          break;
        case 'Highlight':
          if (isZoomedIn) { await zoomOut(page); isZoomedIn = false; }
          await clearHighlightBoxes(page);
          var hlResult = await findAndScrollToText(page, entry.target);
          if (hlResult.found) {
            await drawHighlightBox(page, hlResult.rect);
            await zoomToRect(page, hlResult.rect, { scale: 1.6, durationMs: 1200 });
            isZoomedIn = true;
          }
          break;
        case 'Click':
          if (isZoomedIn) { await zoomOut(page); isZoomedIn = false; }
          await clearHighlightBoxes(page);
          var didClick = await tryClickText(page, entry.target);
          if (!didClick) {
            var clResult = await findAndScrollToText(page, entry.target);
            if (clResult.found) await drawHighlightBox(page, clResult.rect);
          }
          break;
        case 'Wait':
          break;
        case 'Close':
          if (isZoomedIn) { await zoomOut(page); isZoomedIn = false; }
          break;
        default:
          console.warn('Unknown action "' + entry.action + '" for sceneId ' + entry.sceneId + ' - skipping.');
      }

      var holdUntilMs = Math.max(0, entry.end * 1000);
      var elapsedNow = Date.now() - startedAt;
      if (holdUntilMs > elapsedNow) {
        await sleep(holdUntilMs - elapsedNow);
      }
    }

    // Never end the recording mid-zoom -- if the last scene was a Highlight,
    // return to full page view before the tail hold.
    if (isZoomedIn) {
      await zoomOut(page);
      isZoomedIn = false;
    }

    var tailMs = Math.max(0, totalDurationSeconds * 1000 - (Date.now() - startedAt));
    if (tailMs > 0) await sleep(tailMs);
  } finally {
    await page.close();
  }

  var videoPath = await page.video().path();
  await context.close();
  await browser.close();

  return videoPath;
}

function webmToMp4(webmPath) {
  return new Promise(function(resolve, reject) {
    var mp4Path = webmPath.replace(/\.webm$/, '.mp4');
    var ffmpeg = spawn('ffmpeg', [
      '-y',
      '-i', webmPath,
      '-vf', 'scale=' + RECORDING_WIDTH + ':' + RECORDING_HEIGHT + ',fps=30',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '23',
      '-pix_fmt', 'yuv420p',
      mp4Path
    ]);

    var stderr = '';
    ffmpeg.stderr.on('data', function(d) { stderr += d.toString(); });
    ffmpeg.on('error', function(err) { reject(new Error('Failed to start ffmpeg: ' + err.message)); });
    ffmpeg.on('close', function(code) {
      if (code === 0 && fs.existsSync(mp4Path)) {
        resolve(mp4Path);
      } else {
        reject(new Error('ffmpeg exited with code ' + code + '. stderr: ' + stderr.slice(-1000)));
      }
    });
  });
}

app.get('/health', function(req, res) {
  res.json({ status: 'ok', supportedSchemaMajorVersion: SUPPORTED_MAJOR_VERSION });
});

app.post('/record', async function(req, res) {
  if (!WORKER_SECRET) {
    return res.status(500).json({ error: 'Worker misconfigured: WORKER_SECRET is not set on the server.' });
  }
  var providedSecret = req.get('x-worker-secret') || '';
  if (providedSecret !== WORKER_SECRET) {
    return res.status(401).json({ error: 'Unauthorized - missing or incorrect X-Worker-Secret header.' });
  }

  var body = req.body || {};
  var schemaVersion = body.schemaVersion;
  var officialUrl = body.officialUrl;
  var totalDurationSeconds = body.totalDurationSeconds;
  var timeline = body.timeline;

  if (!schemaVersion || typeof schemaVersion !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid "schemaVersion" field.' });
  }
  var majorVersion = schemaVersion.split('.')[0];
  if (majorVersion !== SUPPORTED_MAJOR_VERSION) {
    return res.status(409).json({
      error: 'Unsupported contract version "' + schemaVersion + '". This worker only supports major version ' + SUPPORTED_MAJOR_VERSION + '.x.'
    });
  }
  if (!officialUrl || typeof officialUrl !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid "officialUrl" field.' });
  }
  if (!Array.isArray(timeline) || timeline.length === 0) {
    return res.status(400).json({ error: 'Missing or empty "timeline" array.' });
  }
  var duration = Number(totalDurationSeconds) || timeline[timeline.length - 1].end || 30;
  if (duration > MAX_TOTAL_DURATION_SECONDS) {
    return res.status(400).json({ error: 'totalDurationSeconds (' + duration + ') exceeds the ' + MAX_TOTAL_DURATION_SECONDS + 's safety ceiling.' });
  }

  var outputDir = path.join(os.tmpdir(), 'amin-recording-' + crypto.randomUUID());
  fs.mkdirSync(outputDir, { recursive: true });

  try {
    var webmPath = await runTimeline(officialUrl, timeline, duration, outputDir);
    var mp4Path = await webmToMp4(webmPath);
    var videoBuffer = fs.readFileSync(mp4Path);

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', 'attachment; filename="recording.mp4"');
    res.send(videoBuffer);
  } catch (err) {
    console.error('Recording failed:', err);
    res.status(500).json({ error: 'Recording failed', detail: String((err && err.message) || err) });
  } finally {
    fs.rm(outputDir, { recursive: true, force: true }, function() {});
  }
});

// --- Diagnostic endpoint (temporary) ---
// Loads a page with NO video recording attached, takes a plain screenshot,
// and reports console/page/network errors. Used to isolate whether the
// black-video bug is in page rendering itself vs. the recordVideo/ffmpeg
// pipeline. Does not touch /record, ffmpeg, or any downstream Cloudinary/
// Drive/n8n logic.
app.post('/debug-screenshot', async function(req, res) {
  if (!WORKER_SECRET) {
    return res.status(500).json({ error: 'Worker misconfigured: WORKER_SECRET is not set on the server.' });
  }
  var providedSecret = req.get('x-worker-secret') || '';
  if (providedSecret !== WORKER_SECRET) {
    return res.status(401).json({ error: 'Unauthorized - missing or incorrect X-Worker-Secret header.' });
  }

  var body = req.body || {};
  var officialUrl = body.officialUrl;
  if (!officialUrl || typeof officialUrl !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid "officialUrl" field.' });
  }

  var consoleLogs = [];
  var pageErrors = [];
  var requestFailures = [];
  var browser = null;
  var timedOut = false;

  var timeoutHandle = setTimeout(function() {
    timedOut = true;
  }, DEBUG_SCREENSHOT_TIMEOUT_SECONDS * 1000);

  try {
    browser = await chromium.launch({
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

    var context = await browser.newContext({
      viewport: { width: RECORDING_WIDTH, height: RECORDING_HEIGHT }
      // Deliberately no recordVideo here - isolating page render from video capture.
    });
    var page = await context.newPage();

    page.on('console', function(msg) {
      consoleLogs.push(msg.type() + ': ' + msg.text());
    });
    page.on('pageerror', function(err) {
      pageErrors.push(String(err));
    });
    page.on('requestfailed', function(request) {
      var failure = request.failure();
      requestFailures.push(request.url() + ' -> ' + (failure ? failure.errorText : 'unknown error'));
    });

    var navError = null;
    try {
      await page.goto(officialUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (err) {
      navError = String((err && err.message) || err);
    }

    if (timedOut) {
      throw new Error('Debug screenshot exceeded ' + DEBUG_SCREENSHOT_TIMEOUT_SECONDS + 's timeout before screenshot could be taken.');
    }

    // Let the page settle/paint before capturing.
    await page.waitForTimeout(2000);

    var screenshotBuffer = await page.screenshot({ type: 'png' });

    clearTimeout(timeoutHandle);

    res.setHeader('Content-Type', 'application/json');
    res.json({
      navigationError: navError,
      screenshotBase64: screenshotBuffer.toString('base64'),
      consoleLogs: consoleLogs,
      pageErrors: pageErrors,
      requestFailures: requestFailures
    });
  } catch (err) {
    clearTimeout(timeoutHandle);
    console.error('Debug screenshot failed:', err);
    res.status(500).json({
      error: 'Debug screenshot failed',
      detail: String((err && err.message) || err),
      consoleLogs: consoleLogs,
      pageErrors: pageErrors,
      requestFailures: requestFailures
    });
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (closeErr) {
        console.error('Error closing browser in /debug-screenshot:', closeErr);
      }
    }
  }
});

// --- Diagnostic endpoint (temporary, isolated) ---
// Runs the EXACT same screenshot-loop capture used by runTimeline() for a
// short, fixed duration, then returns three actual sample frames (first,
// middle, last) as base64 PNG in the JSON response so they can be visually
// inspected directly -- instead of inferring from Railway logs alone.
// Does not touch /record, /health, /debug-screenshot, runTimeline(),
// framesToMp4(), or any launch args. Fully separate code path.
app.post('/debug-loop-frames', async function(req, res) {
  if (!WORKER_SECRET) {
    return res.status(500).json({ error: 'Worker misconfigured: WORKER_SECRET is not set on the server.' });
  }
  var providedSecret = req.get('x-worker-secret') || '';
  if (providedSecret !== WORKER_SECRET) {
    return res.status(401).json({ error: 'Unauthorized - missing or incorrect X-Worker-Secret header.' });
  }

  var body = req.body || {};
  var officialUrl = body.officialUrl;
  var testDurationSeconds = Number(body.testDurationSeconds) || 3;
  if (!officialUrl || typeof officialUrl !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid "officialUrl" field.' });
  }

  var browser = null;
  var loopErrors = [];
  var frames = [];

  try {
    browser = await chromium.launch({
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
    var context = await browser.newContext({
      viewport: { width: RECORDING_WIDTH, height: RECORDING_HEIGHT }
    });
    var page = await context.newPage();

    await page.goto(officialUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await tryHideCookieBanner(page);

    var loopStartedAt = Date.now();
    while (Date.now() - loopStartedAt < testDurationSeconds * 1000) {
      var iterStart = Date.now();
      try {
        var buf = await page.screenshot({ type: 'png' });
        frames.push(buf);
      } catch (err) {
        loopErrors.push(String((err && err.message) || err));
      }
      var elapsed = Date.now() - iterStart;
      await sleep(Math.max(0, 100 - elapsed));
    }

    await context.close();
    await browser.close();

    var sampleIndexes = frames.length === 0 ? [] :
      Array.from(new Set([0, Math.floor(frames.length / 2), frames.length - 1]));

    var samples = sampleIndexes.map(function(idx) {
      return { index: idx, base64Png: frames[idx].toString('base64') };
    });

    res.json({
      totalFramesCaptured: frames.length,
      loopErrors: loopErrors,
      samples: samples
    });
  } catch (err) {
    if (browser) {
      try { await browser.close(); } catch (e) {}
    }
    console.error('Debug loop-frames failed:', err);
    res.status(500).json({ error: 'Debug loop-frames failed', detail: String((err && err.message) || err), loopErrors: loopErrors });
  }
});

// --- Diagnostic endpoint (temporary, isolated) ---
// Tests context.recordVideo directly, WITHOUT calling tryHideCookieBanner().
// Purpose: isolate whether recordVideo itself is broken on this Railway
// container (still black even with zero DOM manipulation), or whether
// tryHideCookieBanner()'s page.evaluate() call is what corrupts the
// recording. Records a short fixed-duration clip, converts to mp4, and
// returns it as base64 in the JSON response for direct visual inspection.
// Does not touch /record, runTimeline(), the screenshot-loop capture, or
// framesToMp4(). Fully separate code path.
app.post('/debug-record-test', async function(req, res) {
  if (!WORKER_SECRET) {
    return res.status(500).json({ error: 'Worker misconfigured: WORKER_SECRET is not set on the server.' });
  }
  var providedSecret = req.get('x-worker-secret') || '';
  if (providedSecret !== WORKER_SECRET) {
    return res.status(401).json({ error: 'Unauthorized - missing or incorrect X-Worker-Secret header.' });
  }

  var body = req.body || {};
  var officialUrl = body.officialUrl;
  var testDurationSeconds = Number(body.testDurationSeconds) || 5;
  var testCookieHide = body.testCookieHide === true;
  if (!officialUrl || typeof officialUrl !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid "officialUrl" field.' });
  }

  var testDir = path.join(os.tmpdir(), 'amin-record-test-' + crypto.randomUUID());
  fs.mkdirSync(testDir, { recursive: true });
  var browser = null;

  try {
    browser = await chromium.launch({
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
    var context = await browser.newContext({
      viewport: { width: RECORDING_WIDTH, height: RECORDING_HEIGHT },
      recordVideo: { dir: testDir, size: { width: RECORDING_WIDTH, height: RECORDING_HEIGHT } }
    });
    var page = await context.newPage();

    await page.goto(officialUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Only calls the v3 cookie-hide (addStyleTag-based) function when
    // testCookieHide=true, so the same endpoint can run the baseline
    // (no DOM manipulation) and the cookie-hide variant as two separate,
    // controlled tests.
    if (testCookieHide) {
      await tryHideCookieBannerV3(page);
    }

    await sleep(testDurationSeconds * 1000);

    await page.close();
    var videoPath = await page.video().path();
    await context.close();
    await browser.close();
    browser = null;

    var mp4Path = videoPath.replace(/\.webm$/, '.mp4');
    await new Promise(function(resolve, reject) {
      var ffmpeg = spawn('ffmpeg', [
        '-y',
        '-i', videoPath,
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '23',
        '-pix_fmt', 'yuv420p',
        mp4Path
      ]);
      var stderr = '';
      ffmpeg.stderr.on('data', function(d) { stderr += d.toString(); });
      ffmpeg.on('error', function(err) { reject(new Error('Failed to start ffmpeg: ' + err.message)); });
      ffmpeg.on('close', function(code) {
        if (code === 0 && fs.existsSync(mp4Path)) resolve();
        else reject(new Error('ffmpeg exited with code ' + code + '. stderr: ' + stderr.slice(-1000)));
      });
    });

    var mp4Buffer = fs.readFileSync(mp4Path);
    res.json({
      testDurationSeconds: testDurationSeconds,
      testCookieHide: testCookieHide,
      mp4SizeBytes: mp4Buffer.length,
      mp4Base64: mp4Buffer.toString('base64')
    });
  } catch (err) {
    if (browser) {
      try { await browser.close(); } catch (e) {}
    }
    console.error('Debug record-test failed:', err);
    res.status(500).json({ error: 'Debug record-test failed', detail: String((err && err.message) || err) });
  } finally {
    fs.rm(testDir, { recursive: true, force: true }, function() {});
  }
});

app.listen(PORT, function() {
  console.log('Browser Automation Worker listening on port ' + PORT);
  console.log('Supports Timeline AI contract major version: ' + SUPPORTED_MAJOR_VERSION + '.x');
  console.log('Recording resolution: ' + RECORDING_WIDTH + 'x' + RECORDING_HEIGHT);
  if (!WORKER_SECRET) {
    console.warn('WARNING: WORKER_SECRET is not set - /record will reject all requests until it is.');
  }
});
