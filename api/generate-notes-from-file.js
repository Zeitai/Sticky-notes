// This file runs on Vercel's server, NEVER in the browser.
// Same pattern as api/generate-notes.js, but the source is an uploaded
// image or PDF instead of a typed topic.
//
// Flow:
//   PDF   -> extract text with pdf-parse -> feed extracted text into the
//            normal text prompt (same schema as generate-notes.js)
//   Image -> send the image straight to a Groq VISION model in one call,
//            asking it to read the image AND produce the structured notes
//            JSON directly (skips a separate OCR round-trip)
//
// Both paths return the exact same JSON shape notes.html already knows how
// to render (renderNotebook / renderTable), so no frontend rendering code
// needed to change.

import { jsonrepair } from 'jsonrepair';
import { PDFParse } from 'pdf-parse';

// NOTE ON MODEL NAMES: Groq's model lineup changes over time. The text
// model below matches the one already used in generate-notes.js. The vision
// model is my best guess as of early 2026 for a vision-capable Groq model —
// double check the current name in your Groq console
// (https://console.groq.com/docs/models) before relying on this in
// production, and update GROQ_VISION_MODEL below (or via env var) if it's
// been renamed or retired.
const TEXT_MODEL = 'openai/gpt-oss-20b';
const VISION_MODEL = process.env.GROQ_VISION_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct';

// Vercel serverless functions have a request body size ceiling (4.5MB on
// Hobby plans). Base64 inflates file size by ~37%, so keep the *raw* file
// comfortably under that. Reject early with a clear message instead of a
// confusing platform-level 413.
const MAX_FILE_BYTES = 4 * 1024 * 1024; // 4MB raw file

const SCHEMA_BLOCK_NOTEBOOK = `Respond with ONLY raw JSON (no markdown fences, no commentary), matching this shape exactly:
{
  "title": "Short Topic Title",
  "subtitle": "Complete Notes",
  "period": "e.g. (c. 750 CE - c. 1174 CE), or omit as empty string if not applicable",
  "sections": [
    {"number": 1, "title": "Origin", "type": "bullets", "bullets": ["short point", "short point"]},
    {"number": 2, "title": "Chronology", "type": "table", "columns": ["Col A","Col B","Col C"], "rows": [["a1","b1","c1"], ["a2","b2","c2"]]},
    {"number": 3, "title": "Key People", "type": "numbered", "items": [{"label":"Name","text":"short description"}]},
    {"number": 4, "title": "Some Rivalry/Conflict", "type": "diagram3", "nodes": ["A","B","C"], "notes": ["short note about the relationship"]},
    {"number": 5, "title": "Another Section", "type": "bullets", "bullets": ["..."]}
  ]
}
Rules:
- Derive "title" from what the material is actually about — never say "Uploaded Document" or similar.
- Produce 8 to 11 sections total, covering only what the source material actually supports (do not invent facts not present in the material).
- Use "type":"table" for exactly one section if the material has a natural chronological/list structure (else omit table sections).
- Use "type":"diagram3" for at most one section, only if the material has a genuine three-way relationship/rivalry/structure (else never use diagram3).
- Use "type":"numbered" for a section listing named entities each with a short description.
- All other sections use "type":"bullets".
- Keep bullets/notes under 16 words each. Keep table cell text under 12 words.
- Keep the ENTIRE response compact and within budget — do not pad content or add commentary.
- Output valid JSON only, no trailing commentary.`;

const SCHEMA_BLOCK_TABLE = `Respond with ONLY raw JSON (no markdown fences, no commentary), matching this shape exactly:
{
  "title": "Short Topic Title",
  "subtitle": "Chronology & Key Points",
  "period": "e.g. c. 750 AD - 1174 AD, or empty string if not applicable",
  "columns": ["Entity (Period)", "Chronology", "Major Works & Achievements", "Other Important Points"],
  "rows": [
    {"name": "Name", "period": "c. 750 - 770 AD", "chronology": ["short point","short point"], "works": ["short point","short point","short point"], "other": ["short point","short point"]}
  ],
  "sidebar": {"title": "Important Contributions", "items": ["short point", "short point", "short point"]},
  "timeline": [{"label": "Name", "period": "750-770"}]
}
Rules:
- Derive "title" from what the material is actually about — never say "Uploaded Document" or similar.
- Produce 8 to 14 rows covering the full span of the material's content in chronological/logical order (do not invent facts not present in the material).
- "timeline" is REQUIRED and must NOT be an empty array.
- "sidebar.items" is REQUIRED and must NOT be an empty array — 5 to 8 short general takeaways.
- Every field in the shape above is required. If running low on space, shorten bullets rather than omitting fields.
- Keep each bullet under 14 words.
- Keep the ENTIRE response compact and within budget — do not pad content or add commentary.
- Output valid JSON only, no trailing commentary.`;

function findIncompleteParts(p, tpl) {
  const problems = [];
  if (tpl === 'table') {
    if (!Array.isArray(p?.rows) || p.rows.length === 0) problems.push('rows');
    if (!Array.isArray(p?.sidebar?.items) || p.sidebar.items.length === 0) problems.push('sidebar.items');
    if (!Array.isArray(p?.timeline) || p.timeline.length === 0) problems.push('timeline');
  } else {
    if (!Array.isArray(p?.sections) || p.sections.length === 0) {
      problems.push('sections');
    } else {
      p.sections.forEach((s, i) => {
        const empty =
          (s.type === 'bullets' && (!Array.isArray(s.bullets) || s.bullets.length === 0)) ||
          (s.type === 'table' && (!Array.isArray(s.rows) || s.rows.length === 0)) ||
          (s.type === 'numbered' && (!Array.isArray(s.items) || s.items.length === 0)) ||
          (s.type === 'diagram3' && (!Array.isArray(s.nodes) || s.nodes.length === 0));
        if (empty) problems.push(`sections[${i}] (${s.title || 'untitled'})`);
      });
    }
  }
  return problems;
}

function extractJson(rawText) {
  const clean = rawText.replace(/```json|```/g, '').trim();
  const jsonMatch = clean.match(/\{[\s\S]*\}/);
  const jsonText = jsonMatch ? jsonMatch[0] : clean;
  try {
    return JSON.parse(jsonText);
  } catch (e) {
    return JSON.parse(jsonrepair(jsonText));
  }
}

async function callGroqText(prompt, maxTokens, retriesLeft = 2) {
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: TEXT_MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
      temperature: 0.5,
      response_format: { type: 'json_object' }
    })
  });
  const data = await r.json();
  if (!r.ok) {
    const code = data?.error?.code;
    if (code === 'rate_limit_exceeded' && retriesLeft > 0) {
      const match = /try again in ([0-9.]+)s/i.exec(data?.error?.message || '');
      const waitMs = match ? Math.ceil(parseFloat(match[1]) * 1000) + 300 : 2500;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      return callGroqText(prompt, maxTokens, retriesLeft - 1);
    }
    if (code === 'rate_limit_exceeded') {
      const err = new Error('Groq\'s free tier is briefly rate-limited — please wait a few seconds and try again.');
      err.friendly = true;
      throw err;
    }
    if (code === 'json_validate_failed' && data?.error?.failed_generation) {
      return { choices: [{ message: { content: data.error.failed_generation }, finish_reason: 'stop' }] };
    }
    throw new Error(data?.error?.message || 'Groq request failed');
  }
  return data;
}

// Vision call does NOT use response_format:"json_object" — not every
// vision-capable model on Groq supports strict JSON mode combined with
// image input, so we rely on prompt instructions + the same
// parse/repair/retry pipeline used everywhere else.
async function callGroqVision(prompt, dataUrl, maxTokens, retriesLeft = 2) {
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: VISION_MODEL,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: dataUrl } }
        ]
      }],
      max_tokens: maxTokens,
      temperature: 0.5
    })
  });
  const data = await r.json();
  if (!r.ok) {
    const code = data?.error?.code;
    if (code === 'rate_limit_exceeded' && retriesLeft > 0) {
      const match = /try again in ([0-9.]+)s/i.exec(data?.error?.message || '');
      const waitMs = match ? Math.ceil(parseFloat(match[1]) * 1000) + 300 : 2500;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      return callGroqVision(prompt, dataUrl, maxTokens, retriesLeft - 1);
    }
    throw new Error(data?.error?.message || 'Groq vision request failed');
  }
  return data;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { fileBase64, mimeType, context, template } = req.body || {};
  if (!fileBase64 || !mimeType) {
    return res.status(400).json({ error: 'Missing file' });
  }

  const tpl = template === 'table' ? 'table' : 'notebook';
  const schemaBlock = tpl === 'table' ? SCHEMA_BLOCK_TABLE : SCHEMA_BLOCK_NOTEBOOK;
  const hasContext = context && context.trim().length > 0;
  const contextLine = hasContext
    ? `Write this specifically for someone preparing for: "${context.trim()}". Let that exam/perspective decide depth, jargon, and which points count as "important".`
    : `Write this as a general, well-rounded revision aid (no specific exam assumed).`;

  const buffer = Buffer.from(fileBase64, 'base64');
  if (buffer.length > MAX_FILE_BYTES) {
    return res.status(400).json({ error: `File is too large (max ${Math.round(MAX_FILE_BYTES / (1024 * 1024))}MB).` });
  }

  const isPdf = mimeType === 'application/pdf';
  const isImage = mimeType.startsWith('image/');
  if (!isPdf && !isImage) {
    return res.status(400).json({ error: 'Only PDF and image files are supported.' });
  }

  const MAX_TOKENS = 4500;

  try {
    let parsed;

    if (isPdf) {
      let pdfText;
      let parser;
      try {
        parser = new PDFParse({ data: buffer });
        const result = await parser.getText();
        pdfText = (result.text || '').trim();
      } catch (e) {
        console.error('pdf-parse failed:', e);
        const err = new Error('Could not read that PDF — it may be scanned/image-only or corrupted. Try a text-based PDF, or upload a photo of a page instead.');
        err.friendly = true;
        throw err;
      } finally {
        if (parser) await parser.destroy();
      }
      if (!pdfText || pdfText.length < 20) {
        const err = new Error('No readable text found in that PDF (it may be scanned pages with no text layer). Try uploading a photo of the page instead.');
        err.friendly = true;
        throw err;
      }
      // Cap how much source text we send — keeps prompt + response comfortably
      // within the token budget for large documents.
      const trimmedText = pdfText.slice(0, 14000);

      const prompt = `Below is text extracted from a document. Read it and create a full one-page set of "complete notes" from it — the way a topper's condensed revision sheet looks: several clearly numbered sections covering whatever breakdown genuinely fits this material.

SOURCE MATERIAL:
"""
${trimmedText}
"""

${contextLine}

${schemaBlock}`;

      const data = await callGroqText(prompt, MAX_TOKENS);
      const rawText = data.choices[0].message.content;
      if (data.choices[0].finish_reason === 'length') {
        const err = new Error('The notes were cut off before finishing — please try again (or upload a shorter document).');
        err.friendly = true;
        throw err;
      }
      parsed = extractJson(rawText);
    } else {
      const dataUrl = `data:${mimeType};base64,${fileBase64}`;
      const prompt = `Look at this image of study material (a textbook page, slide, or handwritten notes). Read everything in it, then create a full one-page set of "complete notes" from it — the way a topper's condensed revision sheet looks: several clearly numbered sections covering whatever breakdown genuinely fits this material. If the handwriting is partly illegible, use your best judgement and don't invent facts that clearly aren't there.

${contextLine}

${schemaBlock}`;

      const data = await callGroqVision(prompt, dataUrl, MAX_TOKENS);
      const rawText = data.choices[0].message.content;
      if (data.choices[0].finish_reason === 'length') {
        const err = new Error('The notes were cut off before finishing — please try again.');
        err.friendly = true;
        throw err;
      }
      parsed = extractJson(rawText);
    }

    let problems = findIncompleteParts(parsed, tpl);
    if (tpl === 'table' && (!Array.isArray(parsed?.timeline) || parsed.timeline.length === 0) && Array.isArray(parsed?.rows)) {
      parsed.timeline = parsed.rows.map((r) => ({ label: r.name, period: r.period }));
      problems = problems.filter((p) => p !== 'timeline');
    }

    if (problems.length > 0) {
      console.error('generate-notes-from-file: incomplete result, missing:', problems, parsed);
      const err = new Error('The AI\'s response left out some sections (' + problems.join(', ') + ') — please try again.');
      err.friendly = true;
      throw err;
    }

    parsed.template = tpl;
    return res.status(200).json(parsed);
  } catch (err) {
    console.error(err);
    return res.status(err.friendly ? 429 : 500).json({
      error: err.friendly ? err.message : 'Generation failed',
      detail: String(err)
    });
  }
}
