# CampusVerify v3.2

Reliability fix only — no new features, nothing else changed from v3.1.

## What changed

- **Sequential-fetch timeout risk fixed.** v3.1 fetched its up-to-8
  pages one at a time (worst case 8 × 8s = 64s — past a serverless
  function's timeout window). v3.2 fetches in two parallel rounds
  instead: Round 1 = homepage + seed pages (known upfront). Round 2 =
  links discovered in Round 1, up to whatever's left of the 8-page
  budget. Each round runs concurrently, so worst-case wall-clock time
  is ~2×8s regardless of how many of the 8 pages are slow.
- **8-page cap unchanged**, and now counts every attempt (not just
  successes) — an all-unreachable site can no longer creep past it.
- **`dataComplete` is now honest.** It means "everything CampusVerify
  attempted within its 8-page budget succeeded, and the budget wasn't
  reached while more discovered links were still pending" — not "the
  whole university website was crawled."

## Architecture

- `institutions.js` — whitelist + subdomain-aware matching.
- `patterns.js` — phone/email/bank-name/account/branch/payment extraction.
- `api/crawler.js` — Vercel serverless function, round-based fetching.
- `index.html` / `script.js` / `style.css` — Home, Verify, Info, Report Centre, About, Settings.

## Deploying

Push to GitHub → vercel.com → Add New Project → import → Deploy. No config file, no npm dependencies.

Built by Joe Sin.
