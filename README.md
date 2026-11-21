# Social HQ

Pratham's own social media scheduler: schedule posts at each account's perfect time and see insights for Instagram, Facebook Pages, LinkedIn, YouTube and Pinterest.

- Live at https://socialhq-pratham.vercel.app — hosted on Vercel (free Hobby plan), built from this `social-hq` branch.
- Storage: Supabase (free) — `public.kv` table for records, private `media` bucket for photos/videos.
- Timers: Supabase pg_cron calls `/internal/cron/scheduler` (every 5 min), `/internal/cron/autoreply` (every 3 min) and `/internal/cron/insights` (4× a day).
- Secrets (`MASTER_KEY`, `SETUP_CODE`, `CRON_SECRET`) live encrypted in Supabase; the Supabase key reaches Vercel through the Supabase–Vercel integration — never in this repo.
- The old Netlify site was retired and deleted on 22 Nov 2026 after everything was copied across.

Local tests: `npm install && npm test`
