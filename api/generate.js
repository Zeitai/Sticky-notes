// This file runs on Vercel's server, NEVER in the browser.
// Your API key stays here, read from an environment variable — it is never sent to the visitor.

import { jsonrepair } from 'jsonrepair';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { topic, count, context } = req.body || {};
  if (!topic || !count) {
    return res.status(400).json({ error: 'Missing topic or count' });
  }

  const hasContext = context && context.trim().length > 0;
  const contextLine = hasContext
    ? `Write this specifically for someone preparing for: "${context.trim()}". Let that exam/perspective decide which sub-topics deserve their own note, how much depth or exam-jargon to use, and what "high weightage" or "important" means in the footer — the same chapter should look noticeably different for a school revision vs. a competitive exam like this.`
    : `Write this as a general, well-rounded revision aid (no specific exam assumed).`;

  const prompt = `Create study notes for the topic: "${topic}", broken into exactly ${count} short sections (like sticky notes on a study board covering whatever breakdown fits this topic best: origin, key figures, key concepts, important terms, timeline points, causes, effects, significance, exam-tip style highlights, etc.).

${contextLine}

Respond with ONLY raw JSON (no markdown fences, no commentary, no explanation before or after), matching this shape exactly:
{
  "notes": [
    {"title": "Short Title", "bullets": ["short bullet 1", "short bullet 2", "short bullet 3"]}
  ],
  "footer": "One short exam-tip style sentence summarizing what to focus on${hasContext ? ` for ${context.trim()}` : ''}."
}
Keep each bullet under 14 words. Keep titles under 4 words. Exactly ${count} notes. Keep the ENTIRE response compact — this must fit well within the token budget, so do not pad bullets or add extra commentary. Output valid JSON only.`;

  const provider = process.env.PROVIDER || 'groq'; // 'groq' (free) or 'huggingface' (free, fallback)

  // Token budget scales with how many notes were requested, so large boards
  // (20 notes x 3 bullets) don't get cut off mid-response. Rough estimate:
  // ~55 tokens per note (title + 3 bullets) + fixed overhead for JSON
  // punctuation/keys + the footer sentence, with generous headroom.
  const maxTokensForCount = Math.min(6000, 800 + count * 130);

  // Calls Groq with automatic retry on rate-limit (429) responses, honoring
  // the wait time Groq reports in its own error message.
  async function callGroq(retriesLeft = 2) {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'openai/gpt-oss-20b', // lighter model, more free-tier headroom than 120b
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokensForCount,
        temperature: 0.7,
        // Constrains Groq to emit a single valid JSON object at the API
        // level, instead of relying purely on prompt instructions. This
        // eliminates stray commentary / markdown fences around the JSON.
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
      throw new Error(data?.error?.message || 'Groq request failed');
    }
    return data;
  }

  try {
    let rawText;
    let finishReason;

    if (provider === 'huggingface') {
      // Alternate free option via Hugging Face Inference Providers (OpenAI-compatible router).
      const r = await fetch('https://router.huggingface.co/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.HF_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'meta-llama/Llama-3.1-8B-Instruct:together',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: maxTokensForCount
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
      const err = new Error('The response was cut off before it finished (too many notes requested at once) — try a smaller count, or hit Generate again.');
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
      // The model occasionally hand-writes near-valid JSON (a missing comma
      // between array items, a stray unescaped quote, a trailing comma).
      // jsonrepair fixes these common slip-ups before we give up entirely.
      try {
        parsed = JSON.parse(jsonrepair(jsonText));
      } catch (repairErr) {
        console.error('Raw model output that failed to parse:', jsonText);
        const err = new Error('The AI\'s response wasn\'t valid JSON, even after auto-repair — please hit Generate again.');
        err.friendly = true;
        throw err;
      }
    }

    // Guard against a parsed-but-malformed shape (e.g. missing "notes" array,
    // or fewer notes than requested because the model under-delivered) so the
    // frontend doesn't crash trying to render undefined data.
    if (!parsed || !Array.isArray(parsed.notes) || parsed.notes.length === 0) {
      console.error('Parsed JSON missing expected "notes" array:', parsed);
      const err = new Error('The AI\'s response was missing the notes — please hit Generate again.');
      err.friendly = true;
      throw err;
    }

    return res.status(200).json(parsed);
  } catch (err) {
    console.error(err);
    return res.status(err.friendly ? 429 : 500).json({
      error: err.friendly ? err.message : 'Generation failed',
      detail: String(err)
    });
  }
}
