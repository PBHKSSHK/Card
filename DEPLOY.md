# Deployment

CardRecon is deployed as a static Vite SPA on Vercel, backed by the Supabase
project `nyooltqhmrdnippfikes` (org PBHK, ap-southeast-1).

- **Production URL:** https://cardrecon-pbhk.vercel.app
- **Vercel project:** `cardrecon` (team `pbhk`, id `prj_mkerVXxZ6clig7KH6rTZIXGmN0sy`)
- **Deployment protection:** Vercel Authentication on previews only; production
  is public and relies on the app's own Supabase login.

## How deploys work

The Vercel project is **not** git-linked. Each deployment uploads just two
files, and the build container pulls the real source itself:

- `vercel.json`
  ```json
  {
    "framework": null,
    "installCommand": "rm -rf repo && git clone --depth 1 https://github.com/PBHKSSHK/Card.git repo && cd repo && npm install --include=dev",
    "buildCommand": "cp .env.production repo/.env.production && cd repo && npx vite build && git rev-parse HEAD > dist/public/deployed-sha.txt",
    "outputDirectory": "repo/dist/public",
    "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }]
  }
  ```
- `.env.production` — `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`
  (the anon/publishable key; safe to embed, RLS is the real gate).

`--include=dev` matters: Vercel builds with `NODE_ENV=production`, which would
otherwise make `npm install` skip the devDependencies that contain vite.

The build stamps the checked-out commit into `deployed-sha.txt` at the site
root, so `curl https://cardrecon-pbhk.vercel.app/deployed-sha.txt` always tells
you which commit is live.

## Auto-update

A scheduled Claude routine runs hourly: it compares `git ls-remote … HEAD`
against `deployed-sha.txt` and, when they differ, redeploys with the exact
payload above (via the Vercel MCP `deploy_to_vercel` tool, project name
`cardrecon`) and verifies the new SHA is being served. Quiet no-op runs when
the site is already current.

To deploy manually, replicate the same `deploy_to_vercel` call, or link the
repo to the Vercel project in the dashboard (which would replace this whole
arrangement with native push-to-deploy).
