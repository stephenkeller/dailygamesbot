---
name: fly-deploy-troubleshooting
description: >-
  Use this skill when deploying updates, checking deployment status, reading logs,
  or troubleshooting uptime issues for the daily-games-bot on Fly.io.
---

# Fly.io Bot Operations and Troubleshooting

## Environment Details
- **App Name**: `daily-games-bot-steph`
- **Flyctl Binary**: `~/.fly/bin/flyctl` (Windows PowerShell: `~/.fly/bin/flyctl.exe`)
- **Primary Region**: `iad`

## Deployment Workflow
After making and committing code changes:
1. Ensure git working tree is clean and pushed to GitHub:
   ```bash
   git push origin main
   ```
2. Deploy to Fly.io:
   ```bash
   ~/.fly/bin/flyctl deploy
   ```

## Troubleshooting & Health Checks
When the bot is reported down or unresponsive:

1. **Check Authentication**:
   ```bash
   ~/.fly/bin/flyctl auth whoami
   ```
   If token expired, instruct the user to run `flyctl auth login`.

2. **Inspect App and Machine Status**:
   ```bash
   ~/.fly/bin/flyctl status -a daily-games-bot-steph
   ```
   Note the machine ID and state (`started` vs `stopped`).

3. **Inspect Recent Logs**:
   ```bash
   ~/.fly/bin/flyctl logs -a daily-games-bot-steph
   ```

4. **Common Issue: Max Restart Count Exceeded**:
   - **Symptom**: Machine is `stopped`, logs show `machine has reached its max restart count of 10` after Discord gateway reconnections (`WebSocket closed with 1000`).
   - **Fix**: Restart the machine directly:
     ```bash
     ~/.fly/bin/flyctl machine start <machine_id> -a daily-games-bot-steph
     ```
     Or restart the entire app:
     ```bash
     ~/.fly/bin/flyctl apps restart daily-games-bot-steph
     ```

5. **Verify Bot Reconnection**:
   Check logs to confirm Discord login:
   ```text
   [INFO] discord.gateway: Shard ID None has connected to Gateway
   Logged in as DailyGamesBot (<id>)
   ```
