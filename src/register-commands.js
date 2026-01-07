import { REST } from '@discordjs/rest';
import { Routes } from 'discord.js';
import { SlashCommandBuilder } from '@discordjs/builders';
import { config } from 'dotenv';

// Load environment variables
config();

const commands = [
  new SlashCommandBuilder()
    .setName('person_daily_summary')
    .setDescription('Get today\'s daily work summary for a specific person')
    .addStringOption(option =>
      option
        .setName('person')
        .setDescription('Team member name')
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption(option =>
      option
        .setName('date')
        .setDescription('Date to summarize (YYYY-MM-DD)')
        .setRequired(false)
    )
    .addStringOption(option =>
      option
        .setName('team')
        .setDescription('Filter by specific project/team')
        .setRequired(false)
        .setAutocomplete(true)
    ),

  new SlashCommandBuilder()
    .setName('team_daily_summary')
    .setDescription('Get today\'s team work summary for a specific project')
    .addStringOption(option =>
      option
        .setName('project')
        .setDescription('Project to summarize')
        .setRequired(true)  // Made required
        .setAutocomplete(true)
    )
    .addStringOption(option =>
      option
        .setName('date')
        .setDescription('Date to summarize (YYYY-MM-DD)')
        .setRequired(false)
    )
];

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log('Started refreshing application (/) commands.');

    await rest.put(
      Routes.applicationCommands(process.env.DISCORD_CLIENT_ID),
      { body: commands.map(command => command.toJSON()) }
    );

    console.log('Successfully reloaded application (/) commands.');
    console.log('Commands registered:');
    commands.forEach(cmd => {
      console.log(`- ${cmd.name}: ${cmd.description}`);
      cmd.options?.forEach(opt => {
        console.log(`  └─ ${opt.name} (${opt.required ? 'required' : 'optional'}): ${opt.description}`);
      });
    });
  } catch (error) {
    console.error('Error registering commands:', error);
  }
})();
