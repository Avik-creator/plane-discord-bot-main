# Plane Discord Bot (Cloudflare Workers Edition)

A serverless Discord bot that integrates with [Plane](https://plane.so) project management platform. This bot runs on Cloudflare Workers using the Discord Interactions Endpoint (Webhooks), making it highly scalable, cost-effective, and low-latency.

## Features

- 📝 **Issue Management**
  - Create issues with custom priorities and states
  - View issue details with rich embeds
  - Get lists of issues filtered by status
  - Upload files to issues

- 📊 **AI-Powered Personal Summaries**
  - **New**: `/person_daily_summary` command
  - Rich Discord Embed output with sections for Completed, In Progress, Comments, and Cycles.
  - Surgical user-level filtering (only shows YOUR work).
  - Powered by Google's Gemini AI.

- ⚡ **Serverless Architecture**
  - Runs on Cloudflare Workers.
  - No persistent server required.
  - Uses Discord Interactions (Webhooks).
  - Handles long-running AI tasks via **Deferred Responses** to prevent timeouts.

## Prerequisites

- [Node.js](https://nodejs.org/) >= 18.0.0
- [Cloudflare Account](https://dash.cloudflare.com/) with `wrangler` CLI installed
- A Discord Bot / Application
- A Plane account with API access
- Google Gemini API key (for summaries)

## Getting Started

### 1. Installation

```bash
git clone https://github.com/yourusername/plane-discord-bot.git
cd plane-discord-bot
npm install
```

### 2. Discord Application Setup

1. Go to [Discord Developer Portal](https://discord.com/developers/applications).
2. Create a new application.
3. In the **General Information** tab, copy your **Application ID** and **Public Key**.
4. In the **Bot** tab, generate a **Token**.

### 3. Local Configuration (Secrets)

Cloudflare Workers use secrets for sensitive data. You can set them using Wrangler:

```bash
# Required for Discord
npx wrangler secret put DISCORD_TOKEN
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put DISCORD_APPLICATION_ID

# Required for Plane
npx wrangler secret put PLANE_API_KEY
npx wrangler secret put WORKSPACE_SLUG

# Required for AI Summaries
npx wrangler secret put GOOGLE_GENERATIVE_AI_API_KEY
```

Non-sensitive variables are managed in `wrangler.toml`:
```toml
[vars]
PLANE_BASE_URL = "https://plane.superalign.ai/api/v1"
GEMINI_MODEL = "gemini-2.5-flash"
GEMINI_TEMPERATURE = 0.3
```

### 4. Registering Commands

Before running the worker, you must register the slash commands with Discord:

1. Create a `.env` file with your Discord credentials:
   ```env
   DISCORD_TOKEN=your_discord_bot_token_here
   DISCORD_CLIENT_ID=your_discord_application_id_here
   ```
2. Register the commands:
   ```bash
   npm run register-commands
   ```

### 5. Local Development

To test locally, use `wrangler dev` and a tunnel like `ngrok` to expose your local port (default 8787) to Discord:

```bash
# Start local worker
npx wrangler dev --local --port 8787

# In another terminal, start ngrok
ngrok http 8787
```

Copy the ngrok URL and paste it into the **Interactions Endpoint URL** field in your Discord Developer Portal (App -> General Information). Use `https://your-ngrok-url.com`.

### 6. Production Deployment

```bash
npm run publish
```

Once deployed, update the **Interactions Endpoint URL** in Discord to your worker's production URL (e.g., `https://plane-bot.yourname.workers.dev`).

## Available Commands

| Command                 | Description                                              | Parameters |
| ----------------------- | -------------------------------------------------------- | ---------- |
| `/person_daily_summary` | Get personalized AI daily summary for a team member     | person (required), date (optional), team (optional) |
| `/team_daily_summary`   | Get team work summary for a specific project             | project (required), date (optional) |

### Registering Commands

After setting up environment variables, register the slash commands:

```bash
npm run register-commands
```

This will register the commands with Discord and make them available in your server.

## Project Structure

- `src/server.js`: Main Cloudflare Worker entry point (handles routing & verification).
- `src/services/personDailySummary.js`: Logic for fetching and summarizing personal activity.
- `src/services/planeApiDirect.js`: The direct API client for interacting with Plane.
- `wrangler.toml`: Worker configuration and environment variables.
- `src/deploy-commands.js`: Script to register slash commands with Discord.

## Troubleshooting

- **"Invalid Request Signature"**: Ensure `DISCORD_PUBLIC_KEY` is correct in your secrets.
- **"Application did not respond"**: The bot uses Deferred Responses. Ensure the Worker has enough time to finish background tasks (up to 30s).
- **AI Key Missing**: Ensure `GOOGLE_GENERATIVE_AI_API_KEY` is correctly set via `wrangler secret put`.

## License

MIT License.
