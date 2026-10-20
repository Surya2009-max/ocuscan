# OcuScan Pro

Browser-based vision screening. Screening tool only, not a substitute for an eye exam.

## How it is split

| Part | Where it lives | Hosted on |
|------|----------------|-----------|
| API (scoring, sessions, PDF/CSV) | repo root: `server.js`, `package.json` | Railway |
| Web app (pages, camera tests) | `web/` | Netlify |

The web app only draws questions and forwards answers. Every score is worked out on the server.

## Run it on your own machine

```
npm install
npm start
```

The API comes up on http://localhost:3000. Then open `web/main.html` in a browser, or run `npx serve web`.
When the page is on localhost it talks to the local API on its own.

## Settings the server reads (Railway → Variables)

| Name | What for |
|------|----------|
| `ALLOWED_ORIGINS` | Required. Your Netlify address(es), comma separated, e.g. `https://your-site.netlify.app` |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | Optional. Without them research data is kept in memory only |
| `B2B_API_KEY`, `APP_URL` | Optional. Only for the clinic embed API |
| `PORT` | Railway sets this for you |

## Before you push

Open `web/config.js` and paste your Railway address in place of `YOUR-APP-NAME`.
Put `logo.png`, `icon-192.png` and `icon-512.png` next to `main.html` in `web/`.
