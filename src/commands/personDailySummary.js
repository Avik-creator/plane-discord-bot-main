/**
 * /person_daily_summary Command
 *
 * Generates and displays a daily summary for a specific person.
 * Fetches data directly from Plane API - no database required.
 */
const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");
const {
  getPersonDailySummary,
  generatePersonDailySummaryText,
  getPeople
} = require("../services/personDailySummary");
const { fetchProjects } = require("../services/planeApiDirect");
const logger = require("../utils/logger");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("person_daily_summary")
    .setDescription("Get today's daily work summary for a specific person")
    .addStringOption((option) =>
      option
        .setName("person")
        .setDescription("The person to summarize")
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption((option) =>
      option
        .setName("date")
        .setDescription("Date to summarize (YYYY-MM-DD). Defaults to today.")
        .setRequired(false)
    )
    .addStringOption((option) =>
      option
        .setName("team")
        .setDescription("Team (Project) to filter by")
        .setRequired(false)
        .setAutocomplete(true)
    ),

  async autocomplete(interaction) {
    const focusedOption = interaction.options.getFocused(true);

    if (focusedOption.name === "person") {
      try {
        const people = await getPeople();
        logger.debug(`Autocomplete: Processing ${people.length} people for "${focusedOption.value}"`);

        const choices = people.map((p) => ({
          name: p.name,
          value: p.name,
        }));

        const filtered = choices.filter((choice) =>
          choice.name.toLowerCase().includes(focusedOption.value.toLowerCase())
        );

        logger.debug(`Autocomplete: Found ${filtered.length} matches for "${focusedOption.value}"`);
        await interaction.respond(filtered.slice(0, 25));
      } catch (error) {
        logger.error("Error fetching people for autocomplete:", error);
        await interaction.respond([]);
      }
    } else if (focusedOption.name === "team") {
      try {
        const projects = await fetchProjects();
        const choices = projects.map((p) => ({
          name: p.name || p.identifier || "Unknown",
          value: p.identifier || p.name || p.id,
        }));

        const filtered = choices.filter((choice) =>
          choice.name.toLowerCase().includes(focusedOption.value.toLowerCase())
        );

        await interaction.respond(filtered.slice(0, 25));
      } catch (error) {
        logger.error("Error fetching projects for autocomplete:", error);
        await interaction.respond([]);
      }
    }
  },

  async execute(interaction) {
    const personName = interaction.options.getString("person");
    const dateInput = interaction.options.getString("date");
    const teamFilter = interaction.options.getString("team");

    logger.info(
      `Person daily summary requested by ${interaction.user.username} for ${personName}`,
      { date: dateInput, team: teamFilter }
    );

    await interaction.deferReply();

    try {
      // Parse date
      let targetDate = new Date();
      if (dateInput) {
        targetDate = new Date(dateInput);
        if (isNaN(targetDate.getTime())) {
          return interaction.editReply({
            content: "❌ **Invalid date format**\n\nPlease use YYYY-MM-DD format (e.g., 2025-12-30).",
          });
        }
      }

      const dateKey = targetDate.toISOString().split("T")[0];

      // Fetch structured summary
      const summary = await getPersonDailySummary({
        personName,
        date: dateKey,
        projectFilter: teamFilter,
      });

      // Handle no activities case
      if (!summary.projects || summary.projects.length === 0) {
        const embed = new EmbedBuilder()
          .setColor(0x99aab5)
          .setTitle(`📊 Daily Summary: ${personName}`)
          .setDescription(`No activity recorded for **${personName}** on **${dateKey}**.`)
          .setTimestamp();

        return interaction.editReply({ embeds: [embed] });
      }

      // Generate human-readable summary text using LLM
      const textSummary = await generatePersonDailySummaryText(summary);

      // Build response embed
      const title = `📊 Daily Summary: ${personName} (${dateKey})`;
      const embeds = [];

      // Split summary into chunks if it exceeds Discord's embed limit (4096 chars)
      const MAX_EMBED_LENGTH = 4096;
      let summaryContent = textSummary;

      while (summaryContent.length > 0) {
        let chunk = summaryContent.substring(0, MAX_EMBED_LENGTH);

        if (summaryContent.length > MAX_EMBED_LENGTH) {
          const lastNewline = chunk.lastIndexOf("\n");
          if (lastNewline > MAX_EMBED_LENGTH * 0.8) {
            chunk = summaryContent.substring(0, lastNewline);
          }
        }

        const embed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setTimestamp()
          .setFooter({ text: `Team: ${summary.team} • Page ${embeds.length + 1}` });

        if (embeds.length === 0) {
          embed.setTitle(title).setDescription(chunk);
        } else {
          embed.setDescription(chunk);
        }

        embeds.push(embed);
        summaryContent = summaryContent.substring(chunk.length);
      }

      return interaction.editReply({ embeds });
    } catch (error) {
      logger.error("Error generating person daily summary:", error);
      return interaction.editReply({
        content: "❌ **Error generating summary**\n\nAn error occurred while generating the summary. Please try again later.",
      });
    }
  },
};
