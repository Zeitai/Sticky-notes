# Study Sticky-Note Generator

Type any chapter/topic → get an AI-written sticky-note study board (same visual
style every time, real crisp text — no image-generation model involved) →
download it as a PNG.

## How it works
- `public/index.html` — the page you see, calls `/api/generate`
- `api/generate.js` — a serverless function that runs **on Vercel's servers**,
  not in the browser. This is where your API key is used, so it's never
  exposed to visitors.

## 1. Get a free Groq API key
1. Go to https://console.groq.com and sign up (no credit card required).
2. Go to **API Keys** → **Create API Key**.
3. Copy the key (starts with `gsk_...`).

## 2. Where the key goes — Vercel Environment Variables (NOT in the code)
Never paste the key into any `.js` or `.html` file. Instead:

1. Push this project to a GitHub repo, then import it at https://vercel.com/new
   (or run `vercel` from this folder with the Vercel CLI).
2. In your Vercel project, go to **Settings → Environment Variables**.
3. Add:
   - **Name:** `GROQ_API_KEY`
   - **Value:** the `gsk_...` key you copied
   - **Environment:** Production (and Preview/Development if you want)
4. Redeploy (Vercel → Deployments → ⋯ → Redeploy), so the function picks up
   the new variable.

That's it — the key lives only in Vercel's encrypted environment variable
store and is read by `api/generate.js` via `process.env.GROQ_API_KEY`.

## 3. Testing locally (optional)
```
npm i -g vercel
cp .env.example .env.local     # then edit .env.local with your real key
vercel dev
```
Open the local URL it prints — the same `/api/generate` route runs locally too.

## Switching providers later
`api/generate.js` also supports Hugging Face as a free fallback. Set an
environment variable `PROVIDER=huggingface` and `HF_TOKEN=<your HF token from
huggingface.co/settings/tokens>` instead, if Groq's free limits ever aren't
enough for you.

## Notes
- Groq's free tier has generous but real rate limits (requests/tokens per
  minute and per day). If you hit a rate-limit error, wait a bit or use
  Hugging Face as a backup.
- `llama-3.3-70b-versatile` is used by default — good balance of quality and
  speed for this kind of structured output.
