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
const DEBUG_SCREENSHOT_TIMEOUT_SECONDS = 45;

function sleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

async function findAndScrollToText(page, targetText) {
  var keywords = String(targetText || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(function(w) { return w.length > 3; }).slice(0, 6);
  if (keywords.length === 0) return { found: false };

  return await page.evaluate(function(kws) {
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
      return (a.getBoundingClientRect().width * a.getBoundingClientRect().height) - (b.getBoundingClientRect().width * b.getBoundingClientRect().height);
    });
    var el = candidates[0];
    el.scrollIntoView({ behavior: 'instant', block: 'center' });
    var rect = el.getBoundingClientRect();
    return { found: true, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
  }, keywords);
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
    document.body.appendChild(box);
  }, rect);
}

async function clearHighlightBoxes(page) {
  await page.evaluate(function() {
    document.querySelectorAll('[data-amin-highlight]').forEach(function(el) { el.remove(); });
  });
}

async function tryClickText(page, targetText) {
  var keywords = String(targetText || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(function(w) { return w.length > 3; }).slice(0, 6);
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
      await page.click('a:has-text("' + (keywords[0] || '') + '"), button:has-text("' + (keywords[0] || '') + '")', { timeout: 3000 });
      return true;
    } catch (e) { return false; }
  }
  return false;
}

async function tryHideCookieBanner(page) {
  try {
    await page.evaluate(function() {
      var targetPhrase = 'accept only necessary cookies';
      var candidates = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]'));
      var match = candidates.find(function(el) {
        var text = (el.innerText || el.textContent || el.value || '').trim().toLowerCase();
        return text.indexOf(targetPhrase) !== -1;
      });
      if (!match) return;
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
    });
  } catch (e) {}
}

async function runTimeline(officialUrl, timeline, totalDurationSeconds, outputDir) {
  var browser = await chromium.launch({
    headless: true,
    args: ['--disable-dev-shm-usage', '--no-sandbox', '--disable-setuid-sandbox', '--disable-extensions', '--disable-background-networking', '--no-first-run']
  });
  var context = await browser.newContext({ viewport: { width: RECORDING_WIDTH, height: RECORDING_HEIGHT } });
  var page = await context.newPage();
  var startedAt = Date.now();

  var frameCounter = 0;
  var capturing = true;
  var captureLoopPromise = (async function() {
    while (capturing) {
      var loopStart = Date.now();
      try {
        frameCounter += 1;
        var frameName = 'frame-' + String(frameCounter).padStart(6, '0') + '.jpg';
        var frameBuffer = await page.screenshot({ type: 'jpeg', quality: 80, fullPage: false });
        fs.writeFileSync(path.join(outputDir, frameName), frameBuffer);
      } catch (err) {}
      var elapsed = Date.now() - loopStart;
      await sleep(Math.max(0, 100 - elapsed));
    }
  })();

  try {
    for (var i = 0; i < timeline.length; i++) {
      var entry = timeline[i];
      var targetElapsedMs = Math.max(0, entry.start * 1000);
      var actualElapsedMs = Date.now() - startedAt;
      if (targetElapsedMs > actualElapsedMs) await sleep(targetElapsedMs - actualElapsedMs);

      switch (entry.action) {
        case 'Open':
          await page.goto(entry.officialUrl || officialUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await tryHideCookieBanner(page);
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
      }
      var holdUntilMs = Math.max(0, entry.end * 1000);
      if (holdUntilMs > (Date.now() - startedAt)) await sleep(holdUntilMs - (Date.now() - startedAt));
    }
    var tailMs = Math.max(0, totalDurationSeconds * 1000 - (Date.now() - startedAt));
    if (tailMs > 0) await sleep(tailMs);
  } finally {
    capturing = false;
    await captureLoopPromise;
    await page.close();
    await context.close();
    await browser.close();
  }
  return { outputDir: outputDir, frameCount: frameCounter };
}

function framesToMp4(outputDir, mp4Path) {
  return new Promise(function(resolve, reject) {
    var ffmpeg = spawn('ffmpeg', [
      '-y', '-framerate', '10', '-i', path.join(outputDir, 'frame-%06d.jpg'),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-vf', 'scale=720:1280,fps=30', mp4Path
    ]);
    var stderr = '';
    ffmpeg.stderr.on('data', function(d) { stderr += d.toString(); });
    ffmpeg.on('close', function(code) {
      if (code === 0 && fs.existsSync(mp4Path)) resolve(mp4Path);
      else reject(new Error('ffmpeg failed code ' + code + ': ' + stderr.slice(-500)));
    });
  });
}

app.get('/health', function(req, res) {
  res.json({ status: 'ok', supportedSchemaMajorVersion: SUPPORTED_MAJOR_VERSION });
});

app.post('/record', async function(req, res) {
  if (!WORKER_SECRET || req.get('x-worker-secret') !== WORKER_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  var body = req.body || {};
  if (!body.officialUrl || !Array.isArray(body.timeline)) {
    return res.status(400).json({ error: 'Invalid payload' });
  }
  var duration = Number(body.totalDurationSeconds) || body.timeline[body.timeline.length - 1].end || 30;
  var outputDir = path.join(os.tmpdir(), 'amin-recording-' + crypto.randomUUID());
  fs.mkdirSync(outputDir, { recursive: true });
  var mp4Path = path.join(outputDir, 'recording.mp4');

  try {
    await runTimeline(body.officialUrl, body.timeline, duration, outputDir);
    await framesToMp4(outputDir, mp4Path);
    var videoBuffer = fs.readFileSync(mp4Path);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', 'attachment; filename="recording.mp4"');
    res.send(videoBuffer);
  } catch (err) {
    res.status(500).json({ error: 'Recording failed', detail: String(err.message || err) });
  } finally {
    fs.rm(outputDir, { recursive: true, force: true }, function() {});
  }
});

app.listen(PORT, function() {
  console.log('Worker listening on port ' + PORT);
});
