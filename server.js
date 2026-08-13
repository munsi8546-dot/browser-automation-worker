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

const RECORDING_WIDTH = 720;
const RECORDING_HEIGHT = 1280;

const MAX_TOTAL_DURATION_SECONDS = 180;

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
          await page.goto(entry.officialUrl || officialUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          break;
        case 'Scroll':
          await clearHighlightBoxes(page);
          await findAndScrollToText(page, entry.target);
          break;
        case 'Highlight':
          await clearHighlightBoxes(page);
          var hlResult = await findAndScrollToText(page, entry.target);
          if (hlResult.found) await drawHighlightBox(page, hlResult.rect);
          break;
        case 'Click':
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

app.listen(PORT, function() {
  console.log('Browser Automation Worker listening on port ' + PORT);
  console.log('Supports Timeline AI contract major version: ' + SUPPORTED_MAJOR_VERSION + '.x');
  console.log('Recording resolution: ' + RECORDING_WIDTH + 'x' + RECORDING_HEIGHT);
  if (!WORKER_SECRET) {
    console.warn('WARNING: WORKER_SECRET is not set - /record will reject all requests until it is.');
  }
});
