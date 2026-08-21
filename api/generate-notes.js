// This file runs on Vercel's server, NEVER in the browser.
// Same pattern as api/generate.js — the API key stays server-side.

import { jsonrepair } from 'jsonrepair';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { topic, context, template } = req.body || {};
  if (!topic) {
    return res.status(400).json({ error: 'Missing topic' });
  }
  const tpl = template === 'table' ? 'table' : 'notebook'; // default to notebook

  const hasContext = context && context.trim().length > 0;
  const contextLine = hasContext
    ? `Write this specifically for someone preparing for: "${context.trim()}". Let that exam/perspective decide depth, jargon, and which points count as "important" or "high weightage".`
    : `Write this as a general, well-rounded revision aid (no specific exam assumed).`;

  const notebookPrompt = `Create a full one-page set of "complete notes" on the topic: "${topic}", the way a topper's condensed revision sheet looks: several clearly numbered sections covering whatever breakdown fits this topic (e.g. origin, timeline/chronology, key people, key concepts, causes, effects, structure/administration, achievements, decline, significance, sources — pick whichever genuinely fit "${topic}").

${contextLine}

Respond with ONLY raw JSON (no markdown fences, no commentary), matching this shape exactly:
{
  "title": "Short Topic Title",
  "subtitle": "Complete Notes",
  "period": "e.g. (c. 750 CE – c. 1174 CE), or omit as empty string if not applicable",
  "sections": [
    {"number": 1, "title": "Origin", "type": "bullets", "bullets": ["short point", "short point"]},
    {"number": 2, "title": "Chronology", "type": "table", "columns": ["Col A","Col B","Col C"], "rows": [["a1","b1","c1"], ["a2","b2","c2"]]},
    {"number": 3, "title": "Key People", "type": "numbered", "items": [{"label":"Name","text":"short description"}]},
    {"number": 4, "title": "Some Rivalry/Conflict", "type": "diagram3", "nodes": ["A","B","C"], "notes": ["short note about the relationship"]},
    {"number": 5, "title": "Another Section", "type": "bullets", "bullets": ["..."]}
  ]
}
Rules:
- Produce 8 to 11 sections total.
- Use "type":"table" for exactly one section if the topic has a natural chronological/ruler/date list (else omit table sections).
- Use "type":"diagram3" for at most one section, only if the topic has a genuine three-way relationship/rivalry/structure (else never use diagram3).
- Use "type":"numbered" for a section listing named entities each with a short description.
- All other sections use "type":"bullets".
- Keep bullets/notes under 16 words each. Keep table cell text under 12 words.
- Keep the ENTIRE response compact and within budget — do not pad content or add commentary.
- Output valid JSON only, no trailing commentary.`;

  const tablePrompt = `Create a "chronology / master table" style complete-notes page on the topic: "${topic}", laid out like a big reference table of the topic's main entities in order (e.g. rulers, events, stages, eras — pick whichever fits "${topic}") plus a short sidebar of overall key contributions and a bottom summary timeline.

${contextLine}

Respond with ONLY raw JSON (no markdown fences, no commentary), matching this shape exactly:
{
  "title": "Short Topic Title",
  "subtitle": "Chronology & Key Points",
  "period": "e.g. c. 750 AD – 1174 AD, or empty string if not applicable",
  "columns": ["Entity (Period)", "Chronology", "Major Works & Achievements", "Other Important Points"],
  "rows": [
    {"name": "Name", "period": "c. 750 – 770 AD", "chronology": ["short point","short point"], "works": ["short point","short point","short point"], "other": ["short point","short point"]}
  ],
  "sidebar": {"title": "Important Contributions", "items": ["short point", "short point", "short point"]},
  "timeline": [{"label": "Name", "period": "750-770"}]
}
Rules:
- Produce 8 to 14 rows covering the full span of the topic in chronological/logical order.
- "timeline" is REQUIRED and must NOT be an empty array — include exactly one entry per row, same order, short label + short period.
- "sidebar.items" is REQUIRED and must NOT be an empty array — include 5 to 8 short points, general takeaways about the whole topic (not entity-specific).
- Every field in the shape above is required. Do not leave any array empty — if you are running low on space, shorten individual bullets rather than omitting whole fields.
- Keep each bullet under 14 words.
- Keep the ENTIRE response compact and within budget — do not pad content or add commentary.
- Output valid JSON only, no trailing commentary.`;

  const prompt = tpl === 'table' ? tablePrompt : notebookPrompt;
  const provider = process.env.PROVIDER || 'groq';

  // This schema is considerably more complex than the sticky-notes endpoint
  // (nested section types, tables-of-arrays, diagrams), so it needs more
  // headroom to avoid truncating mid-object. 4500 gives real margin over the
  // previous flat 3500 for an 8-14 row/section response.
  const MAX_TOKENS = 4500;

  async function callGroq(retriesLeft = 2) {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'openai/gpt-oss-20b',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: MAX_TOKENS,
        temperature: 0.6,
        // Constrains Groq to emit a single valid JSON object at the API
        // level — this schema has nested types (table/diagram3/numbered)
        // which give a freeform model more ways to go off-format, so this
        // matters more here than on simpler endpoints.
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
        return callGroq(retriesLeft - 1);
      }
      if (code === 'rate_limit_exceeded') {
        const err = new Error('Groq\'s free tier is briefly rate-limited — please wait a few seconds and hit Generate again.');
        err.friendly = true;
        throw err;
      }
      // Groq's response_format:"json_object" mode validates the model's
      // output server-side. When validation fails, Groq does NOT return
      // normal `choices` content — it returns this error instead, but still
      // includes the raw (malformed) text it generated under
      // `error.failed_generation`. Recover that text and feed it through our
      // normal parse/repair pipeline rather than giving up immediately.
      if (code === 'json_validate_failed' && data?.error?.failed_generation) {
        console.error('Groq json_validate_failed — recovered failed_generation for repair attempt.');
        return {
          choices: [{
            message: { content: data.error.failed_generation },
            finish_reason: 'stop'
          }]
        };
      }
      throw new Error(data?.error?.message || 'Groq request failed');
    }
    return data;
  }

  try {
    let rawText;
    let finishReason;

    if (provider === 'huggingface') {
      const r = await fetch('https://router.huggingface.co/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.HF_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'meta-llama/Llama-3.1-8B-Instruct:together',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: MAX_TOKENS
        })
      });
      const data = await r.json();
      if (!r.ok) throw new Error(JSON.stringify(data));
      rawText = data.choices[0].message.content;
      finishReason = data.choices[0].finish_reason;
    } else {
      const data = await callGroq();
      rawText = data.choices[0].message.content;
      finishReason = data.choices[0].finish_reason;
    }

    // If the model ran out of tokens mid-response, the JSON is guaranteed to
    // be incomplete — surface a clear, specific error instead of the vague
    // "invalid JSON" message, so it's obvious what actually happened.
    if (finishReason === 'length') {
      console.error('Model output was truncated (finish_reason=length). Raw text:', rawText);
      const err = new Error('The notes were cut off before they finished generating — please hit Generate again.');
      err.friendly = true;
      throw err;
    }

    const clean = rawText.replace(/```json|```/g, '').trim();
    const jsonMatch = clean.match(/\{[\s\S]*\}/);
    const jsonText = jsonMatch ? jsonMatch[0] : clean;

    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (parseErr) {
      try {
        parsed = JSON.parse(jsonrepair(jsonText));
      } catch (repairErr) {
        console.error('Raw model output that failed to parse:', jsonText);
        const err = new Error('The AI\'s response wasn\'t valid JSON, even after auto-repair — please hit Generate again.');
        err.friendly = true;
        throw err;
      }
    }

    // Guard against a parsed-but-malformed/incomplete shape so the frontend
    // doesn't silently render empty panels. The model can return technically
    // valid JSON that still skips required parts (e.g. rows filled in but
    // sidebar.items or timeline left empty) — this must be checked field by
    // field, not just "did JSON.parse succeed".
    function findIncompleteParts(p) {
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

    let problems = findIncompleteParts(parsed);

    // If some parts came back empty, the model likely rushed the tail end of
    // its response. Auto-fill what can be safely derived from other fields...
    if (tpl === 'table' && (!Array.isArray(parsed?.timeline) || parsed.timeline.length === 0) && Array.isArray(parsed?.rows)) {
      parsed.timeline = parsed.rows.map((r) => ({ label: r.name, period: r.period }));
      problems = problems.filter((p) => p !== 'timeline');
    }

    // ...and if genuinely required content is still missing (can't be
    // derived, e.g. sidebar takeaways or whole sections), ask the model
    // once more for a complete response before giving up.
    if (problems.length > 0) {
      console.error('First attempt incomplete, missing:', problems, '— retrying once. Parsed:', parsed);
      const retryData = await callGroq();
      const retryRawText = retryData.choices[0].message.content;
      const retryFinishReason = retryData.choices[0].finish_reason;

      if (retryFinishReason !== 'length') {
        const retryClean = retryRawText.replace(/```json|```/g, '').trim();
        const retryMatch = retryClean.match(/\{[\s\S]*\}/);
        const retryJsonText = retryMatch ? retryMatch[0] : retryClean;
        try {
          const retryParsed = JSON.parse(retryJsonText);
          const retryProblems = findIncompleteParts(retryParsed);
          if (tpl === 'table' && (!Array.isArray(retryParsed?.timeline) || retryParsed.timeline.length === 0) && Array.isArray(retryParsed?.rows)) {
            retryParsed.timeline = retryParsed.rows.map((r) => ({ label: r.name, period: r.period }));
          }
          // Use the retry if it's strictly more complete than the original.
          if (retryProblems.length < problems.length) {
            parsed = retryParsed;
            problems = retryProblems.filter((p) => p !== 'timeline');
          }
        } catch (e) {
          // Retry failed to parse — fall through and use whatever the first
          // attempt had, flagged below.
        }
      }
    }

    if (problems.length > 0) {
      console.error('Still incomplete after retry, missing:', problems, ':', parsed);
      const err = new Error('The AI\'s response left out some sections (' + problems.join(', ') + ') — please hit Generate again.');
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
