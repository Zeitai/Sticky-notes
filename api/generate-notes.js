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
- "timeline" should have exactly one entry per row, same order, short label + short period.
- sidebar.items should have 5 to 8 short points, general takeaways about the whole topic (not entity-specific).
- Keep each bullet under 14 words.
- Output valid JSON only, no trailing commentary.`;

  const prompt = tpl === 'table' ? tablePrompt : notebookPrompt;
  const provider = process.env.PROVIDER || 'groq';

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
        max_tokens: 3500,
        temperature: 0.6
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
      throw new Error(data?.error?.message || 'Groq request failed');
    }
    return data;
  }

  try {
    let rawText;

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
          max_tokens: 3500
        })
      });
      const data = await r.json();
      if (!r.ok) throw new Error(JSON.stringify(data));
      rawText = data.choices[0].message.content;
    } else {
      const data = await callGroq();
      rawText = data.choices[0].message.content;
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
