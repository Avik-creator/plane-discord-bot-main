# Plane Discord Bot

A Discord bot that integrates with [Plane](https://plane.so) project management platform, enabling teams to manage issues and get AI-powered work summaries directly from Discord.

## Features

- 📝 **Issue Management**

  - Create issues with custom priorities and states
  - View issue details with rich embeds
  - Get lists of issues filtered by status
  - Upload files to issues

- 📊 **AI-Powered Team Summaries**

  - Daily work summaries
  - Weekly work summaries
  - Team sync reports
  - Powered by Google's Gemini AI

- 🔗 **Seamless Integration**
  - Direct integration with Plane API
  - Real-time issue updates
  - Interactive slash commands

## Prerequisites

- Node.js >= 18.0.0
- A Discord Bot Token
- A Plane account with API access
- (Optional) Docker and Docker Compose for containerized deployment

## Installation

### Local Development

1. **Clone the repository**

   ```bash
   git clone https://github.com/yourusername/plane-discord-bot.git
   cd plane-discord-bot
   ```

2. **Install dependencies**

   ```bash
   npm install
   ```

3. **Set up environment variables**

   Create a `.env` file in the root directory:

   ```env
   # Discord Configuration
   DISCORD_TOKEN=your_discord_bot_token
   DISCORD_CLIENT_ID=your_discord_application_id

   # Plane Configuration
   PLANE_API_KEY=your_plane_api_key
   WORKSPACE_SLUG=your_workspace_slug

   # Optional: Logging Configuration
   LOG_LEVEL=info
   ENABLE_FILE_LOGS=false

   # Optional: AI Configuration (for summaries)
   GOOGLE_API_KEY=your_google_gemini_api_key
   ```

4. **Deploy commands to Discord**

   ```bash
   npm run deploy
   ```

5. **Start the bot**

   ```bash
   npm start
   ```

   For development with auto-reload:

   ```bash
   npm run dev
   ```

### Docker Deployment

1. **Using Docker Compose (Recommended)**

   ```bash
   docker-compose up -d
   ```

2. **Using Docker directly**
   ```bash
   docker build -t plane-discord-bot .
   docker run -d --env-file .env plane-discord-bot
   ```

## Getting Your Credentials

### Discord Bot Setup

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application
3. Go to the "Bot" section and create a bot
4. Copy the bot token (this is your `DISCORD_TOKEN`)
5. Copy the Application ID from the "General Information" section (this is your `DISCORD_CLIENT_ID`)
6. Enable the following bot permissions:
   - Send Messages
   - Use Slash Commands
   - Embed Links
   - Attach Files
7. Invite the bot to your server using the OAuth2 URL generator with `applications.commands` and `bot` scopes

### Plane API Setup

1. Log in to your [Plane](https://plane.so) workspace
2. Go to Settings → API Tokens
3. Generate a new API token (this is your `PLANE_API_KEY`)
4. Your workspace slug is the URL path: `https://app.plane.so/{workspace_slug}`

### Google Gemini API (Optional - for AI summaries)

1. Go to [Google AI Studio](https://makersuite.google.com/app/apikey)
2. Create an API key
3. Add it as `GOOGLE_API_KEY` in your `.env` file

## Available Commands

| Command                | Description                        | Options                                                  |
| ---------------------- | ---------------------------------- | -------------------------------------------------------- |
| `/create-issue`        | Create a new issue in Plane        | title, description, priority, state                      |
| `/view-issue`          | View details of a specific issue   | issue-id                                                 |
| `/get-issues`          | Get a list of issues               | state (all, backlog, todo, in-progress, done, cancelled) |
| `/upload-file`         | Upload a file to an issue          | issue-id, file                                           |
| `/team-daily-summary`  | Get AI-powered daily team summary  | -                                                        |
| `/team-weekly-summary` | Get AI-powered weekly team summary | -                                                        |
| `/team-sync`           | Get team synchronization report    | -                                                        |

## Project Structure

```
plane-discord-bot/
├── src/
│   ├── commands/          # Discord slash commands
│   │   ├── createIssue.js
│   │   ├── viewIssue.js
│   │   ├── getIssues.js
│   │   ├── uploadFile.js
│   │   ├── teamDailySummary.js
│   │   ├── teamWeeklySummary.js
│   │   └── teamSync.js
│   ├── config/            # Configuration files
│   │   ├── config.js
│   │   └── config.enhanced.js
│   ├── services/          # External service integrations
│   │   ├── planeApi.js
│   │   └── planeApiDirect.js
│   └── utils/             # Utility functions
│       ├── logger.js
│       └── utils.js
├── docker-compose.yml     # Docker Compose configuration
├── Dockerfile             # Development Dockerfile
├── Dockerfile.production  # Production Dockerfile
├── package.json
└── .env.example          # Environment variables template

```

## Configuration

### Environment Variables

| Variable            | Required | Description                              | Default |
| ------------------- | -------- | ---------------------------------------- | ------- |
| `DISCORD_TOKEN`     | ✅       | Your Discord bot token                   | -       |
| `DISCORD_CLIENT_ID` | ✅       | Your Discord application ID              | -       |
| `PLANE_API_KEY`     | ✅       | Your Plane API key                       | -       |
| `WORKSPACE_SLUG`    | ✅       | Your Plane workspace slug                | -       |
| `GOOGLE_API_KEY`    | ❌       | Google Gemini API key (for AI summaries) | -       |
| `LOG_LEVEL`         | ❌       | Logging level (debug, info, warn, error) | `info`  |
| `ENABLE_FILE_LOGS`  | ❌       | Enable file-based logging                | `false` |

### Database (Docker Deployment)

When using Docker Compose, PostgreSQL is included:

| Variable            | Required | Description                       | Default             |
| ------------------- | -------- | --------------------------------- | ------------------- |
| `POSTGRES_USER`     | ❌       | PostgreSQL username               | `plane_bot`         |
| `POSTGRES_PASSWORD` | ❌       | PostgreSQL password               | `changeme`          |
| `POSTGRES_DB`       | ❌       | PostgreSQL database name          | `plane_discord_bot` |
| `DATABASE_URL`      | ❌       | Full PostgreSQL connection string | Auto-generated      |

## Development

### Adding New Commands

1. Create a new file in `src/commands/yourCommand.js`
2. Follow the Discord.js slash command structure:

   ```javascript
   const { SlashCommandBuilder } = require("discord.js");

   module.exports = {
     data: new SlashCommandBuilder()
       .setName("your-command")
       .setDescription("Command description"),
     async execute(interaction) {
       // Your command logic here
     },
   };
   ```

3. Run `npm run deploy` to register the command with Discord

### Logging

The bot uses Winston for structured logging:

```javascript
const logger = require("./utils/logger");

logger.info("Info message", { metadata: "value" });
logger.error("Error message", { error: err });
logger.debug("Debug message");
```

## Troubleshooting

### Bot doesn't respond to commands

- Ensure the bot has proper permissions in your Discord server
- Check that commands are deployed: `npm run deploy`
- Verify the bot is online in your Discord server
- Check logs for errors: set `LOG_LEVEL=debug` in `.env`

### Plane API errors

- Verify your `PLANE_API_KEY` is valid
- Check that your `WORKSPACE_SLUG` is correct
- Ensure your API key has necessary permissions in Plane

### AI summaries not working

- Verify `GOOGLE_API_KEY` is set and valid
- Check Google AI Studio for API usage limits
- Ensure your Plane workspace has issues with activity

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Support

For issues, questions, or contributions, please open an issue on the GitHub repository.

## Acknowledgments

- Built with [Discord.js](https://discord.js.org/)
- Integrates with [Plane](https://plane.so)
- AI powered by [Google Gemini](https://ai.google.dev/)

---

Made with ❤️ for better team collaboration
