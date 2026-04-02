# Watch_CMD

A Netflix-style movie & TV browser with **server-proxied trailers that actually work**.

## Why a backend?

YouTube blocks trailer embeds based on the HTTP `Referer` header — studios whitelist only specific domains. A browser iframe always sends your site's domain, so it gets blocked (Error 153).

This backend fixes it by:
1. Fetching the YouTube video stream **server-side** — no Referer header
2. Piping raw video bytes to the browser as a native `<video>` element
3. Browser never touches YouTube directly — no domain check, no block

---

## Local Development

```bash
npm install
cp .env.example .env        # then add your TMDb key
npm run dev                 # http://localhost:3000
```

---

## Deploy to Railway (free tier, ~10 minutes)

### 1. Push to GitHub
```bash
git init && git add . && git commit -m "init"
git remote add origin https://github.com/YOUR_USERNAME/watch-cmd.git
git push -u origin main
```

### 2. Create Railway project
- Go to railway.app, sign in with GitHub
- New Project → Deploy from GitHub repo → select watch-cmd
- Railway auto-detects Node.js and runs `npm start`

### 3. Add environment variable
- Railway dashboard → your service → Variables tab
- Add: `TMDB_KEY = your_key_here`
- Do NOT add PORT — Railway sets that automatically

### 4. Get your public URL
- Settings → Networking → Generate Domain
- You get a free *.up.railway.app URL

---

## Get a Free TMDb API Key
1. Sign up at themoviedb.org
2. Settings → API → Create → Developer
3. Copy the API Key (v3 auth)

---

## API Endpoints

| Endpoint | Description |
|---|---|
| GET /api/tmdb/* | Relays TMDb calls (key stays server-side) |
| GET /api/trailer/movie/:id | Finds best trailer YouTube key for a movie |
| GET /api/trailer/tv/:id | Finds best trailer YouTube key for a TV show |
| GET /api/proxy/trailer/:videoId | Streams video via proxy — bypasses embed block |
| GET /health | Health check |

---

## Troubleshooting

**Trailers stop working?** ytdl-core breaks occasionally when YouTube updates.
Fix: `npm update ytdl-core` then push — Railway auto-redeploys.
