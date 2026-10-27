# Bharat Brief

India and world current-affairs briefing for exam revision. Cost: Rs 0. Never add a payment method; if any service asks for one, stop.
This is an educational tool, not an official exam authority. Story links point to the original publishers; read them.

## How it works
- `index.html` : the website (Cloudflare Pages, auto-deploys from GitHub).
- `worker/` : API that reads the database (Cloudflare Worker + D1).
- `scripts/ingest.mjs` + `scripts/sources.json` : fetches feeds, removes duplicates, groups reports of one event, publishes an edition. Runs in GitHub Actions at 7:00 AM, 1:00 PM, 7:00 PM IST (01:30, 07:30, 13:30 UTC). GitHub may start a run 10-30 minutes late; the site shows the real publish time.
- No AI is used. "Why it matters" / "what to watch" stay empty until optional summaries are added.

## Accounts and secrets
Free accounts: GitHub, Cloudflare. Secrets live only in GitHub (Settings > Secrets and variables > Actions): `CF_API_TOKEN` (Cloudflare token, permission Account > D1 > Edit) and `CF_ACCOUNT_ID`. Never put them in files or chat. If one leaks, delete it in Cloudflare and make a new one.

## Free limits (checked Oct 2026; re-check occasionally)
Workers Free: 100,000 requests/day, 10 ms CPU per run. D1 Free: 5M row reads/day, 100k writes/day, 500 MB. At a limit, queries fail until midnight UTC; nothing is billed on the Free plan. Data older than 90 days is deleted automatically.

## Source rules
Edit `scripts/sources.json`. Set `"enabled": 0` to stop a feed. Only headline, a 300-character snippet and the link are stored. Do not add feeds that need logins or block automated reading (PIB and Indian Express returned HTTP 403 and are disabled). Check each publisher's terms.

## Evidence labels
Confirmed = an official source published it (not independently verified here). Developing = reported, details may change. Allegation = contains allegations or disputed claims. Analysis = opinion or explainer. Labels are rule-based and never upgraded automatically.

## Launch checklist
- [ ] Site opens on a phone; text readable in light and dark theme
- [ ] Morning / Afternoon / Evening tabs load; empty slots say "not published yet"
- [ ] Exam chips and State PSC state selector change ordering
- [ ] Open 3 stories: source links open the right article; dates show in IST
- [ ] Save a story, reload, saved-only shows it; Clear removes it
- [ ] Actions tab shows green ticks; DB status line shows sources read
- [ ] Turn off Wi-Fi: page shows sample banner, not blank
- [ ] No token or key appears in any GitHub file
