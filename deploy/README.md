Deploy payload for the Vercel project `cardrecon` (team pbhk).
Upload exactly these two files via the Vercel MCP `deploy_to_vercel` tool
(target "production", name "cardrecon", teamId "team_AoE2kp6VsqIBDHDhzQts4Lud").
The VITE_SUPABASE_ANON_KEY here is the public (publishable) key — it is already
embedded in the shipped JS bundle; row security is enforced by RLS.
See ../DEPLOY.md for the full story.
