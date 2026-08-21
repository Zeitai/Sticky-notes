// This file runs on Vercel's server, NEVER in the browser.
// Your API key stays here, read from an environment variable — it is never sent to the visitor.

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
Keep each bullet under 14 words. Keep titles under 4 words. Exactly ${count} notes. Output valid JSON only.`;

  const provider = process.env.PROVIDER || 'groq'; // 'groq' (free) or 'huggingface' (free, fallback)

  try {
    let rawText;

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
          max_tokens: 2000
        })
      });
      const data = await r.json();
      if (!r.ok) throw new Error(JSON.stringify(data));
      rawText = data.choices[0].message.content;
    } else {
      // Groq — genuinely free tier, no billing card required. console.groq.com
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'openai/gpt-oss-120b',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 2000,
          temperature: 0.7
        })
      });
      const data = await r.json();
      if (!r.ok) throw new Error(JSON.stringify(data));
      rawText = data.choices[0].message.content;
    }

    const clean = rawText.replace(/```json|```/g, '').trim();
    const jsonMatch = clean.match(/\{[\s\S]*\}/);
    const jsonText = jsonMatch ? jsonMatch[0] : clean;
    const parsed = JSON.parse(jsonText);
    return res.status(200).json(parsed);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Generation failed', detail: String(err) });
  }
}
