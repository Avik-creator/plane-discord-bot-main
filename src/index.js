import "dotenv/config";
import {
  Client,
  Collection,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
} from "discord.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import config from "./config/config.enhanced.js";
import { initPlaneService } from "./services/planeApiDirect.js";
import logger from "./utils/logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Log startup information
logger.info("Starting Discord bot (Gateway mode)...", {
  node_version: process.version,
  platform: process.platform,
});

// Initialize Plane API service
initPlaneService(config);
logger.info("Plane API service initialized for Discord bot");

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.commands = new Collection();
const commandsPath = path.join(__dirname, "commands");
const commandFiles = fs
  .readdirSync(commandsPath)
  .filter((file) => file.endsWith(".js"));

const commandsData = [];

// Initialize command loading
for (const file of commandFiles) {
  const filePath = path.join(commandsPath, file);
  const commandModule = await import(`file://${filePath}`);
  const command = commandModule.default || commandModule;
  if ("data" in command && "execute" in command) {
    client.commands.set(command.data.name, command);
    commandsData.push(command.data.toJSON());
    logger.debug(`Loaded command: ${command.data.name}`);
  }
}

client.once(Events.ClientReady, async () => {
  logger.info("Discord bot is ready!", {
    username: client.user.tag,
    guilds: client.guilds.cache.size,
  });

  // Register/update commands on Discord
  try {
    logger.info(`Refreshing ${commandsData.length} application commands...`);

    const rest = new REST().setToken(config.DISCORD_TOKEN);

    const data = await rest.put(
      Routes.applicationCommands(config.DISCORD_CLIENT_ID),
      { body: commandsData }
    );

    logger.info(`Successfully refreshed ${data.length} application commands`, {
      commands: data.map((cmd) => cmd.name),
    });
  } catch (error) {
    logger.error("Failed to refresh application commands:", error);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // Handle autocomplete
    if (interaction.isAutocomplete()) {
      const command = client.commands.get(interaction.commandName);

      if (!command || !command.autocomplete) {
        logger.warn(
          `No autocomplete handler for command: ${interaction.commandName}`
        );
        return;
      }

      try {
        await command.autocomplete(interaction);
      } catch (error) {
        logger.error(
          `Error handling autocomplete for ${interaction.commandName}:`,
          error
        );
        await interaction.respond([]);
      }
      return;
    }

    // Handle slash commands
    if (interaction.isChatInputCommand()) {
      const command = client.commands.get(interaction.commandName);

      if (!command) {
        logger.warn(
          `No command matching ${interaction.commandName} was found.`
        );
        return;
      }

      try {
        logger.debug(`Executing command: ${interaction.commandName}`, {
          user: interaction.user.tag,
          guild: interaction.guild?.name,
        });
        await command.execute(interaction);
      } catch (error) {
        logger.error(
          `Error executing command: ${interaction.commandName}`,
          error
        );
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp({
            content: "There was an error executing this command!",
            ephemeral: true,
          });
        } else {
          await interaction.reply({
            content: "There was an error executing this command!",
            ephemeral: true,
          });
        }
      }
    }
  } catch (error) {
    logger.error("Error in interaction handler", error);
  }
});

client.login(config.DISCORD_TOKEN).catch((error) => {
  logger.error("Failed to login to Discord", error);
  process.exit(1);
});
