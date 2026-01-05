/**
 * /team_weekly_summary Command (Admin Only)
 *
 * Generates and displays a weekly summary of ALL team work.
 * Fetches data directly from Plane API - no database required.
 */
const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");
const {
  getTeamActivities,
  fetchProjects,
} = require("../services/planeApiDirect");
const config = require("../config/config.enhanced");
const { generateText } = require("ai");
const { google } = require("@ai-sdk/google");
const logger = require("../utils/logger");

const SYSTEM_PROMPT = `You are a team work summary formatter. Your ONLY job is to convert structured team work activities and work items into readable sentences.

STRICT RULES:
1. ONLY describe activities that are explicitly provided
2. DO NOT infer intent, mood, or additional context
3. DO NOT add encouragement, opinions, or commentary
4. Use clear, professional language
5. Group related activities together (e.g., all changes to one work item)
6. Use bullet points for clarity
7. Include work item identifiers when referencing work items
8. Show individual contributors where activities relate to them
9. Aggregate similar activities across the team

ACTIVITY TYPES:
- "activity": Changes made to a work item (status, priority, etc)
- "comment": Discussion/comments on a work item from team members
- "subitem": Sub-issues/child work items with their progress
- "work_item_snapshot": Work items created or updated in the period (shown with current state)

OUTPUT FORMAT:
- Start with a high-level summary (e.g., "The team had 50 activities this week across 12 work items")
- Group by day, then by work item
- Under each work item, list the activities with contributor information
- For subitems, show progress information (e.g., "3 of 5 tasks completed - 60%")
- Show assignees for subitems
- Include sections for: Work Items Created/Updated, Status Changes, Subitem Progress, Comments/Discussions, Other Updates
- For work_item_snapshot items, show: state, priority, assignees, description
- Include actual comment text for user discussions
- End with key metrics and highlights

If no activities are provided, respond with: "No team activity found for this period."`;

const WEEKLY_SUMMARY_PROMPT = `Convert these team activities into a weekly summary for the week of {{startDate}} to {{endDate}}. Include all activities, updates, and team discussions/comments.

ACTIVITIES (in JSON format):
{{activities}}

Remember: ONLY describe what is explicitly in the activities above. Do not add any interpretation.
Show team activity aggregated by work item and contributor. Include comment content to show team discussions.
Show team activity aggregated by day first, then by work item and contributor.
Highlight completed items and any blocking issues.`;

module.exports = {
  data: new SlashCommandBuilder()
    .setName("team_weekly_summary")
    .setDescription("Get this week's team work summary (Admin only)")
    .addStringOption((option) =>
      option
        .setName("end_date")
        .setDescription(
          "End date for the week (YYYY-MM-DD). Defaults to today."
        )
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

    const endDateInput = interaction.options.getString("end_date");
    const projectFilter = interaction.options.getString("project");

    logger.info(
      `Team weekly summary requested by ${interaction.user.username}`,
      {
        endDate: endDateInput,
        project: projectFilter,
      }
    );

    await interaction.deferReply();

    try {
      // Parse end date
      let endDate = new Date();
      if (endDateInput) {
        endDate = new Date(endDateInput);
        if (isNaN(endDate.getTime())) {
          return interaction.editReply({
            content:
              "❌ **Invalid date format**\n\nPlease use YYYY-MM-DD format (e.g., 2025-12-30).",
          });
        }
      }

      // Calculate start date (7 days before)
      const startDate = new Date(endDate);
      startDate.setDate(startDate.getDate() - 7);
      startDate.setHours(0, 0, 0, 0);

      const endOfDay = new Date(endDate);
      endOfDay.setHours(23, 59, 59, 999);

      const startDateKey = startDate.toISOString().split("T")[0];
      const endDateKey = endDate.toISOString().split("T")[0];

      logger.info(
        `Fetching team activities for ${startDateKey} to ${endDateKey}${
          projectFilter ? ` (project: ${projectFilter})` : ""
        }`
      );

      // Fetch activities directly from Plane API
      const activities = await getTeamActivities(
        startDate,
        endOfDay,
        projectFilter
      );

      // Handle no activities case
      if (activities.length === 0) {
        const title = projectFilter
          ? `📊 Team Weekly Summary for ${projectFilter} (${startDateKey} to ${endDateKey})`
          : `📊 Team Weekly Summary (${startDateKey} to ${endDateKey})`;
        const embed = new EmbedBuilder()
          .setColor(0x99aab5)
          .setTitle(title)
          .setDescription("No team activity found for this period.")
          .setFooter({ text: "0 activities" })
          .setTimestamp();

        return interaction.editReply({ embeds: [embed] });
      }

      const userPrompt = WEEKLY_SUMMARY_PROMPT.replace(
        "{{startDate}}",
        startDateKey
      )
        .replace("{{endDate}}", endDateKey)
        .replace("{{activities}}", JSON.stringify(activities, null, 2));

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
          maxTokens: 2000,
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
        ? `📊 Team Weekly Summary for ${projectFilter} (${startDateKey} to ${endDateKey})`
        : `📊 Team Weekly Summary (${startDateKey} to ${endDateKey})`;

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
            text: `${activities.length} activities this week • Page ${
              embeds.length + 1
            }`,
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
      logger.error("Error generating team weekly summary:", error);

      return interaction.editReply({
        content:
          "❌ **Error generating summary**\n\nAn error occurred. Please try again later.",
      });
    }
  },
};
