'use strict';

/**
 * Amin AI Global Opportunity Platform — PDF Generator Worker
 *
 * Consumes a versioned "Digital Product Content Contract v1" and returns a
 * formatted PDF. Deliberately generic across product types (ebook, resume
 * template, planner, checklist, guide, worksheet) - it just renders whatever
 * structure it's given; the Digital Product Content Agent (n8n) decides what
 * content and page-break structure suits each product type.
 *
 * Contract (schemaVersion "1.0"):
 * {
 *   "schemaVersion": "1.0",
 *   "productType": "ebook",
 *   "title": "Study Abroad Budget Planner",
 *   "subtitle": "A practical guide to planning your finances",
 *   "sections": [
 *     {
 *       "heading": "Chapter 1: Understanding Tuition Costs",
 *       "body": "Tuition costs vary significantly by country...",
 *       "bulletPoints": ["Public universities are often cheaper", "..."],
 *       "pageBreakBefore": true
 *     }
 *   ]
 * }
 *
 * VERSIONING RULE (same discipline as the Browser Automation worker's contract):
 * only major version "1" is understood. A "2.x"+ schemaVersion is rejected
 * with a clear 409 rather than guessed at.
 */

const express = require('express');
const PDFDocument = require('pdfkit');
const { PassThrough } = require('stream');

const app = express();
app.use(express.json({ limit: '5mb' }));

const PORT = process.env.PORT || 8080;
const WORKER_SECRET = process.env.WORKER_SECRET || '';
const SUPPORTED_MAJOR_VERSION = '1';
const MAX_SECTIONS = 60;

function renderPdf(payload) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 60, size: 'LETTER', bufferPages: true });
      const stream = new PassThrough();
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
      doc.pipe(stream);

      // --- Title page ---
      doc.fontSize(28).font('Helvetica-Bold').text(payload.title || 'Untitled', { align: 'center' });
      if (payload.subtitle) {
        doc.moveDown(0.8);
        doc.fontSize(14).font('Helvetica').fillColor('#555555').text(payload.subtitle, { align: 'center' });
        doc.fillColor('#000000');
      }

      // --- Sections ---
      const sections = Array.isArray(payload.sections) ? payload.sections : [];
      sections.forEach((section) => {
        if (section.pageBreakBefore) {
          doc.addPage();
        } else {
          doc.moveDown(1.5);
        }

        if (section.heading) {
          doc.fontSize(18).font('Helvetica-Bold').text(section.heading);
          doc.moveDown(0.5);
        }
        if (section.body) {
          doc.fontSize(11).font('Helvetica').text(section.body, { align: 'justify' });
        }
        if (Array.isArray(section.bulletPoints) && section.bulletPoints.length > 0) {
          doc.moveDown(0.5);
          section.bulletPoints.forEach((point) => {
            doc.fontSize(11).font('Helvetica').text(`•  ${point}`, { indent: 20 });
          });
        }
      });

      // --- Page numbers (footer) ---
      const range = doc.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        doc.fontSize(9).fillColor('#888888').text(
          `${i + 1} / ${range.count}`,
          0,
          doc.page.height - 40,
          { align: 'center' }
        );
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', supportedSchemaMajorVersion: SUPPORTED_MAJOR_VERSION });
});

app.post('/generate', async (req, res) => {
  if (!WORKER_SECRET) {
    return res.status(500).json({ error: 'Worker misconfigured: WORKER_SECRET is not set on the server.' });
  }
  if ((req.get('x-worker-secret') || '') !== WORKER_SECRET) {
    return res.status(401).json({ error: 'Unauthorized - missing or incorrect X-Worker-Secret header.' });
  }

  const body = req.body || {};
  const { schemaVersion, title, sections } = body;

  if (!schemaVersion || typeof schemaVersion !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid "schemaVersion" field.' });
  }
  const majorVersion = schemaVersion.split('.')[0];
  if (majorVersion !== SUPPORTED_MAJOR_VERSION) {
    return res.status(409).json({
      error: `Unsupported contract version "${schemaVersion}". This worker only supports major version ${SUPPORTED_MAJOR_VERSION}.x.`
    });
  }
  if (!title || typeof title !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid "title" field.' });
  }
  if (!Array.isArray(sections) || sections.length === 0) {
    return res.status(400).json({ error: 'Missing or empty "sections" array.' });
  }
  if (sections.length > MAX_SECTIONS) {
    return res.status(400).json({ error: `Too many sections (${sections.length}); safety ceiling is ${MAX_SECTIONS}.` });
  }

  try {
    const pdfBuffer = await renderPdf(body);
    const safeFilename = (title || 'document').replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 60);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error('PDF generation failed:', err);
    res.status(500).json({ error: 'PDF generation failed', detail: String((err && err.message) || err) });
  }
});

app.listen(PORT, () => {
  console.log(`PDF Generator Worker listening on port ${PORT}`);
  console.log(`Supports contract major version: ${SUPPORTED_MAJOR_VERSION}.x`);
  if (!WORKER_SECRET) {
    console.warn('WARNING: WORKER_SECRET is not set - /generate will reject all requests until it is.');
  }
});
