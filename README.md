# Amin AI — PDF Generator Worker

PDFKit-based worker that turns structured content (title + sections) into a
formatted PDF — used for any digital product the platform sells: ebooks,
resume templates, planners, checklists, guides. One generic worker for all
of them, since it just renders whatever structure it's given; the content
(and how it should be paginated) comes from the n8n Digital Product Content
Agent, not hardcoded here.

**Genuinely tested, not just written:** every code path was run for real in a
sandbox — health check, a 2-chapter ebook-style PDF (6 pages, correct
pagination via `pageBreakBefore`), a compact resume-template-style PDF (2
pages, confirmed *not* forced onto extra pages), and all 3 guard rails (401
without the secret header, 409 on an unsupported contract version, 400 on
missing required fields). The one thing not tested is a real cloud deployment
and real AI-generated content (vs. the hand-written test payloads used here)
— smoke-test with real output from the Digital Product Content Agent after
deploying.

## Contract (schemaVersion "1.0")

```json
{
  "schemaVersion": "1.0",
  "productType": "ebook",
  "title": "Study Abroad Budget Planner",
  "subtitle": "A practical guide to planning your finances",
  "sections": [
    {
      "heading": "Chapter 1: Understanding Tuition Costs",
      "body": "Tuition costs vary significantly by country...",
      "bulletPoints": ["Public universities are often cheaper", "..."],
      "pageBreakBefore": true
    }
  ]
}
```

- `pageBreakBefore` (optional, per section): the CONTENT AGENT decides pagination,
  not this worker. Set it `true` for chapter starts in an ebook; leave it unset
  for compact documents like resume templates where sections should flow together.
- Only major version `1.x` is accepted — a `2.x`+ `schemaVersion` returns a clear
  409 instead of being guessed at, same versioning discipline as the Browser
  Automation worker's contract.

## Deploy (Render.com free tier)

1. Push this folder to a GitHub repo
2. Render → New → Web Service → connect repo → Environment: **Docker** (auto-detects the Dockerfile) → Free tier
3. Environment variable: `WORKER_SECRET` = a long random string — **required**
4. Deploy

Same free-tier cold-start caveat as the other two workers applies (first
request after idle time is slower). This worker is lighter than the other
two though — no browser, no video encoding — so cold starts and requests are
both fast.

## Smoke test after deploying

```bash
curl https://YOUR-WORKER-URL/health
# {"status":"ok","supportedSchemaMajorVersion":"1"}

curl -X POST https://YOUR-WORKER-URL/generate \
  -H "Content-Type: application/json" \
  -H "X-Worker-Secret: YOUR_WORKER_SECRET" \
  -d '{
    "schemaVersion": "1.0",
    "title": "Test Document",
    "sections": [{ "heading": "Section 1", "body": "This is a test." }]
  }' \
  --output test.pdf
```

If `test.pdf` opens and shows "Test Document" with "Section 1", it's working.

## Wiring into n8n (Digital Product Content Agent)

- Trigger with `{ productType, topic }`
- AI agent generates the structured content contract shown above (title,
  subtitle, sections with heading/body/bulletPoints/pageBreakBefore) —
  type-aware via the system prompt (an ebook gets chapter-style sections with
  page breaks; a resume template gets compact placeholder sections without them)
- HTTP Request node → POST to this worker's `/generate` with the JSON body
  - Response format: File (binary) — the PDF comes back directly
- Since neither Gumroad nor most other marketplaces support auto-creating a
  new product listing via API (a real platform limitation, documented
  elsewhere in the platform), the generated PDF + title + description get
  handed to Manual Task Logger for the one unavoidable manual step: actually
  listing it for sale.

## Known limitations (by design)

- **No images/cover art** — pure text/PDFKit layout. A cover image would need
  either a bundled template image (same pattern as Video Renderer's brand
  assets) or an upstream image-generation step feeding this worker a URL/binary.
- **Basic typography only** — headings, body text, bullet points, page
  numbers. No tables, columns, or custom fonts out of the box; PDFKit
  supports all of these if a specific product type needs richer layout later.
  assets) or an upstream image-generation step feeding this worker a URL/binary.
- **Basic typography only** — headings, body text, bullet points, page
  numbers. No tables, columns, or custom fonts out of the box; PDFKit
  supports all of these if a specific product type needs richer layout later.
