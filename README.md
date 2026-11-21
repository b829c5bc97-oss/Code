# Social HQ

Pratham's own social media scheduler: schedule posts at each account's perfect time and see insights for Instagram, Facebook Pages, LinkedIn, YouTube and Pinterest.

- Hosted on Netlify (project `socialhq-pratham`), built from this `social-hq` branch.
- Storage: Netlify Blobs. Scheduler: Netlify scheduled function every 5 minutes; publishing runs as a background function.
- Secrets live in Netlify environment variables (`MASTER_KEY`, `SETUP_CODE`) and encrypted in Blobs — never in this repo.

Local tests: `npm install && npm test`
