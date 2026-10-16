# Dinner Planner

Shared weekly dinner planner. Runs as one Docker container; data lives in `./data/state.json`.

## First install on the server
1. `cp .env.example .env`, then edit `.env` and set `HOUSEHOLD_CODE` (long and random: `openssl rand -base64 18`).
2. `docker compose up -d --build`
3. Check: `curl -I http://127.0.0.1:3000`
4. Make it reachable: `tailscale funnel --bg 3000` (use `--https=8443` if port 443 is already in use).
5. On both phones: open the address, enter the household code, then Add to Home Screen.

## Update after a change on GitHub
`git pull && docker compose up -d --build`

## Optional: AI ideas
Put an Anthropic API key in `.env` as `ANTHROPIC_API_KEY`, then `docker compose up -d`.

## Backup
Copy `./data/state.json`.
