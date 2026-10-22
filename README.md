# SitcomEnglish: deploy guide

A static website (`public/index.html`) plus a small Node server (`server.js`, no packages needed) that talks to the Anthropic API.
The API key lives only on the server, so visitors can never see or steal it.

## 1. Get an API key
Create one at https://console.anthropic.com (API keys). Set a monthly spend limit there.

## 2. Run it on your computer
```
export ANTHROPIC_API_KEY=your-key-here      # Windows PowerShell: $env:ANTHROPIC_API_KEY="your-key-here"
npm start
```
Open http://localhost:3000

## 3. Deploy to your official website
Any host that runs Node 18+ works. Easiest on Render (similar steps on Railway or Fly.io):
1. Put this folder in a GitHub repo (the `.gitignore` already keeps `.env` out).
2. Render > New > Web Service > pick the repo.
3. Build command: leave empty (no packages to install). Start command: `npm start`.
4. Add environment variable `ANTHROPIC_API_KEY` (and optionally the ones in `.env.example`).
5. Deploy, then add your domain under Settings > Custom Domains. HTTPS is automatic.

If your official site is already on another host, either deploy this app on a subdomain (for example `learn.yoursite.com`)
or keep it as is and set `ALLOWED_ORIGIN` to your site's address.

## 4. Before you launch
- **Voice chat needs HTTPS and Chrome or Edge.** It works on your live domain. Safari/Firefox visitors can still type and hear the tutor.
- **Series names.** The menu uses names of real shows (The Office, Friends and so on) only as labels, and the tutors are original characters. For a public commercial site, safest is to rename the channels to generic genres (for example "Office Comedy", "Family Comedy") and keep the "not affiliated" line.
- **Privacy.** Chat messages go to Anthropic through your server. Add a short privacy note on the site.
- **Cost control.** The server limits each visitor (default 40 messages per 10 minutes). Lower `RATE_LIMIT_MAX` if needed and keep a spend limit on the API key.
- **If the AI is down,** the tutor falls back to a built-in brain that explains idioms and runs quizzes, so the page never looks broken.
