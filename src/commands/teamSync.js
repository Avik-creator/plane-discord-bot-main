/**
 * /team_sync Command (Admin Only)
 *
 * Tests connectivity to the Plane API and shows workspace stats.
 * Since we're using direct API calls (no database), this verifies API access.
 */
import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import {
  fetchProjects,
  getWorkItemsSnapshot,
} from "../services/planeApiDirect.js";
import logger from "../utils/logger.js";

export default {
  data: new SlashCommandBuilder()
    .setName("team_sync")
    .setDescription(
      "Test Plane API connectivity and show workspace stats (Admin only)"
    ),

  async execute(interaction) {
    // Admin check
    if (!interaction.member.permissions.has("Administrator")) {
      return interaction.reply({
        content: "❌ This command is admin-only.",
        flags: 64,
      });
    }

    logger.info(`API test triggered by ${interaction.user.username}`);

    await interaction.deferReply();

    try {
      const startTime = Date.now();

      // Fetch projects to verify API access
      const projects = await fetchProjects();

      if (projects.length === 0) {
        const embed = new EmbedBuilder()
          .setColor(0xffa500)
          .setTitle("⚠️ No Projects Found")
          .setDescription(
            "API is accessible but no projects found in workspace."
          )
          .setTimestamp();

        return interaction.editReply({ embeds: [embed] });
      }

      // Get work items snapshot
      const snapshot = await getWorkItemsSnapshot();

      const durationMs = Date.now() - startTime;

      // Build success embed
      const embed = new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle("✅ Plane API Connected Successfully")
        .addFields(
          {
            name: "Projects",
            value: `${projects.length}`,
            inline: true,
          },
          {
            name: "Total Work Items",
            value: `${snapshot.total}`,
            inline: true,
          },
          {
            name: "Open Items",
            value: `${
              snapshot.byStatus.backlog +
              snapshot.byStatus.unstarted +
              snapshot.byStatus.started
            }`,
            inline: true,
          },
          {
            name: "Completed Items",
            value: `${snapshot.byStatus.completed}`,
            inline: true,
          },
          {
            name: "Cancelled Items",
            value: `${snapshot.byStatus.cancelled}`,
            inline: true,
          },
          {
            name: "Response Time",
            value: `${durationMs}ms`,
            inline: true,
          }
        )
        .setDescription(
          `**Projects:** ${projects.map((p) => p.name).join(", ")}`
        )
        .setTimestamp();

      logger.info(
        `API test completed in ${durationMs}ms - ${projects.length} projects, ${snapshot.total} work items`
      );

      return interaction.editReply({ embeds: [embed] });
    } catch (error) {
      logger.error("API test failed:", error);

      const embed = new EmbedBuilder()
        .setColor(0xff0000)
        .setTitle("❌ API Connection Failed")
        .setDescription(`**Error:** ${error.message}`)
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }
  },
};
