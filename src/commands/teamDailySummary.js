/**
 * /team_daily_summary Command (Admin Only)
 *
 * Generates and displays a daily summary of ALL team work.
 * Fetches data directly from Plane API - no database required.
 */
const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");
const { getTeamActivities } = require("../services/planeApiDirect");
const { fetchProjects } = require("../services/planeApiDirect");
const config = require("../config/config.enhanced");
const { generateText } = require("ai");
const { google } = require("@ai-sdk/google");
const logger = require("../utils/logger");

const SYSTEM_PROMPT = `You are a team work summary formatter. Your ONLY job is to convert structured team work activities into readable text using a specific format.

STRICT RULES:
1. ONLY describe activities that are explicitly provided
2. DO NOT infer intent, mood, or additional context
3. DO NOT add encouragement, opinions, or commentary
4. Use clear, professional language

OUTPUT FORMAT:
For each project the team worked on, output:
Project Name
Cycle Name - Cycle Status -> %completed

<Person Name>
<Tasks/SubTasks Done>
<Tasks/SubTasks in Progress>

- Group activities by project first
- Replace "Project Name" with the actual project name
- Replace "Cycle Name" with the actual cycle name
- Replace "%completed" with the cycle completion percentage (calculate as: completedIssues/totalIssues * 100, round to nearest integer)
- If no cycles exist for the project, use "No active cycles"
- For each person who worked on the project, show their section with:
  - <Person Name> (replace with actual person name)
  - Tasks/SubTasks Done: List all completed work items and subtasks for that person (bullet points, include ID and name)
  - Tasks/SubTasks in Progress: List all in-progress work items and subtasks for that person (bullet points, include ID, name, and state)
- Separate each person's section with a blank line
- Separate each project with a blank line
- Only include people who have activity in that project

If no activities are provided, respond with: "No team activity found for this period."`;

const DAILY_SUMMARY_PROMPT = `Convert these team activities into a daily summary for {{date}}. Include all activities, updates, and team discussions/comments.

ACTIVITIES (in JSON format):
{{activities}}

Remember: ONLY describe what is explicitly in the activities above. Do not add any interpretation.
Show team activity aggregated by work item and contributor. Include comment content to show team discussions.`;

module.exports = {
  data: new SlashCommandBuilder()
    .setName("team_daily_summary")
    .setDescription("Get today's team work summary (Admin only)")
    .addStringOption((option) =>
      option
        .setName("date")
        .setDescription("Date to summarize (YYYY-MM-DD). Defaults to today.")
        .setRequired(false)
    )
    .addStringOption((option) =>
      option
        .setName("project")
        .setDescription("Project to filter by (optional)")
        .setRequired(false)
        .setAutocomplete(true)
    ),

  async autocomplete(interaction) {
    const focusedOption = interaction.options.getFocused(true);

    if (focusedOption.name === "project") {
      try {
        logger.info("Fetching projects for autocomplete...");
        const projects = await fetchProjects();
        logger.info(`Found ${projects.length} projects for autocomplete`);

        if (!projects || projects.length === 0) {
          await interaction.respond([
            { name: "No projects found", value: "none" },
          ]);
          return;
        }

        const choices = projects.map((p) => ({
          name: p.name || p.identifier || "Unknown",
          value: p.identifier || p.name || p.id,
        }));

        await interaction.respond(choices.slice(0, 25)); // Discord limits to 25 choices
      } catch (error) {
        logger.error("Error fetching projects for autocomplete:", error);
        await interaction.respond([
          { name: "Error loading projects", value: "error" },
        ]);
      }
    }
  },

  async execute(interaction) {
    // Admin check
    if (!interaction.member.permissions.has("Administrator")) {
      return interaction.reply({
        content: "❌ This command is admin-only.",
        flags: 64, // Ephemeral
      });
    }

    const dateInput = interaction.options.getString("date");
    const projectFilter = interaction.options.getString("project");

    logger.info(
      `Team daily summary requested by ${interaction.user.username}`,
      {
        date: dateInput,
        project: projectFilter,
      }
    );

    await interaction.deferReply();

    try {
      // Parse date
      let targetDate = new Date();
      if (dateInput) {
        targetDate = new Date(dateInput);
        if (isNaN(targetDate.getTime())) {
          return interaction.editReply({
            content:
              "❌ **Invalid date format**\n\nPlease use YYYY-MM-DD format (e.g., 2025-12-30).",
          });
        }
      }

      const startOfDay = new Date(targetDate);
      startOfDay.setHours(0, 0, 0, 0);

      const endOfDay = new Date(targetDate);
      endOfDay.setHours(23, 59, 59, 999);

      const dateKey = targetDate.toISOString().split("T")[0];

      logger.info(
        `Fetching team activities for ${dateKey}${projectFilter ? ` (project: ${projectFilter})` : ""
        }`
      );

      // Fetch activities directly from Plane API
      const activities = await getTeamActivities(
        startOfDay,
        endOfDay,
        projectFilter
      );

      // Handle no activities case
      if (activities.length === 0) {
        const title = projectFilter
          ? `📊 Team Daily Summary for ${projectFilter} (${dateKey})`
          : `📊 Team Daily Summary for ${dateKey}`;
        const embed = new EmbedBuilder()
          .setColor(0x99aab5)
          .setTitle(title)
          .setDescription("No team activity found for this period.")
          .setFooter({ text: "0 activities" })
          .setTimestamp();

        return interaction.editReply({ embeds: [embed] });
      }

      const userPrompt = DAILY_SUMMARY_PROMPT.replace(
        "{{date}}",
        dateKey
      ).replace("{{activities}}", JSON.stringify(activities, null, 2));

      logger.info(
        `Calling Gemini API with ${activities.length} activities (${userPrompt.length} chars prompt)`
      );

      const geminiStartTime = Date.now();

      // Call Gemini without timeout limit
      let summary;
      try {
        const result = await generateText({
          model: google(config.GEMINI_MODEL),
          system: SYSTEM_PROMPT,
          prompt: userPrompt,
          temperature: config.GEMINI_TEMPERATURE,
        });

        summary = result.text;
        const geminiTime = Date.now() - geminiStartTime;
        logger.info(
          `Gemini response received in ${geminiTime}ms (${summary.length} chars)`
        );
      } catch (error) {
        const geminiTime = Date.now() - geminiStartTime;
        logger.error(
          `Gemini API error after ${geminiTime}ms: ${error.message}`
        );
        throw error;
      }

      // Build response embed
      const title = projectFilter
        ? `📊 Team Daily Summary for ${projectFilter} (${dateKey})`
        : `📊 Team Daily Summary for ${dateKey}`;

      // Discord embed description limit is 4096 characters
      const MAX_EMBED_LENGTH = 4096;

      let summaryContent = summary;
      const embeds = [];

      // Split summary into chunks if it exceeds limit
      while (summaryContent.length > 0) {
        let chunk = summaryContent.substring(0, MAX_EMBED_LENGTH);

        // Try to cut at a natural break point (newline)
        if (summaryContent.length > MAX_EMBED_LENGTH) {
          const lastNewline = chunk.lastIndexOf("\n");
          if (lastNewline > MAX_EMBED_LENGTH * 0.8) {
            // If newline is in last 20%, use it
            chunk = summaryContent.substring(0, lastNewline);
          }
        }

        const embed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setFooter({
            text: `${activities.length} activities • Page ${embeds.length + 1}`,
          })
          .setTimestamp();

        if (embeds.length === 0) {
          // First embed gets the title
          embed.setTitle(title).setDescription(chunk);
        } else {
          // Continuation embeds
          embed.setDescription(chunk);
        }

        embeds.push(embed);
        summaryContent = summaryContent.substring(chunk.length);
      }

      return interaction.editReply({ embeds });
    } catch (error) {
      logger.error("Error generating team daily summary:", error);

      return interaction.editReply({
        content:
          "❌ **Error generating summary**\n\nAn error occurred while generating the summary. Please try again later.",
      });
    }
  },
};
