/**
 * /team_daily_summary Command (Admin Only)
 *
 * Generates and displays a daily summary of ALL team work.
 * Shows each team member's completed and in-progress work for the selected project.
 * Format: Project Name -> Cycle Name -> %completed -> Team members with their tasks
 */
import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import {
  getTeamActivities,
  fetchProjects,
  getCyclesWithCache,
  getProjectMembers,
  clearActivityCaches,
} from "../services/planeApiDirect.js";
import config from "../config/config.enhanced.js";
import { generateText } from "ai";
import { google } from "@ai-sdk/google";
import logger from "../utils/logger.js";

/**
 * State detection patterns (case-insensitive)
 */
const STATE_PATTERNS = {
  completed: ["done", "closed", "complete", "completed"],
  blocked: ["block", "blocked", "blocking"],
  inProgress: ["progress", "in progress", "review", "active", "working"],
};

/**
 * Check if a state string matches a category
 */
function matchesStateCategory(state, category) {
  if (!state || typeof state !== "string") return false;
  const stateLower = state.toLowerCase();
  const patterns = STATE_PATTERNS[category] || [];
  return patterns.some((pattern) => stateLower.includes(pattern));
}

const SYSTEM_PROMPT = `You are a team work summary formatter. Your ONLY job is to convert structured team work data into readable text using a SPECIFIC format.

STRICT RULES:
1. ONLY describe activities that are explicitly provided in the data
2. DO NOT infer intent, mood, or additional context
3. DO NOT add encouragement, opinions, or commentary
4. Use clear, professional language
5. Follow the EXACT output format below
6. Include comments showing progress updates on tasks (e.g., "Updated via comment: task description")

OUTPUT FORMAT:

**PROJECT_NAME**
CYCLE_NAME -> X% completed

**TEAM_MEMBER_A**

**Tasks/SubTasks Done:**
• TASK-ID: Task Name
[or "None" if no completed items]

**Tasks/SubTasks in Progress:**
• TASK-ID: Task Name (State)
[or "None" if no in-progress items]

**Comments/Updates:**
• TASK-ID: Brief comment summary
[or "None" if no comments]

**TEAM_MEMBER_B**

**Tasks/SubTasks Done:**
• TASK-ID: Task Name

**Tasks/SubTasks in Progress:**
• TASK-ID: Task Name (State)

**Comments/Updates:**
• TASK-ID: Brief comment summary

[Continue for all team members...]

---

FORMATTING RULES:
- Project name should be in bold
- Cycle info on its own line with arrow and percentage
- Each team member name should be in bold
- Use bullet points (•) for task lists
- Include task ID and name for each item
- For in-progress items, include the state in parentheses
- For comments, include the task ID and a brief summary of the update
- If a member has no completed tasks, show "None" under Done
- If a member has no in-progress tasks, show "None" under In Progress
- If a member has no comments, show "None" under Comments/Updates
- Separate team members with blank lines
- Only include team members who have activity for the date

If no team members have activities, respond with: "No team activity found for this period."`;

const DAILY_SUMMARY_PROMPT = `Format this team daily summary for {{date}} using the exact format specified. Include comments as they show progress on tasks even when there are no formal state changes.

PROJECT: {{projectName}}
CYCLE INFO: {{cycleInfo}}

TEAM MEMBERS DATA:
{{teamData}}

Generate the formatted output now. Use ALL data provided. Do not omit any team members, tasks, or comments.`;

export default {
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
        .setDescription("Project to get team summary for")
        .setRequired(true)
        .setAutocomplete(true)
    ),

  async autocomplete(interaction) {
    try {
      const focusedOption = interaction.options.getFocused(true);

      if (focusedOption.name === "project") {
        try {
          logger.debug(`Autocomplete: Fetching projects for "${focusedOption.value}"`);
          const projects = await fetchProjects();
          logger.debug(`Autocomplete: Found ${projects.length} projects`);

          const choices = projects.map((p) => ({
            name: p.name || p.identifier || "Unknown",
            value: p.identifier || p.name || p.id,
          }));

          // Filter by user input
          const filtered = choices.filter((choice) =>
            choice.name.toLowerCase().includes(focusedOption.value.toLowerCase())
          );

          logger.debug(`Autocomplete: Found ${filtered.length} matches for "${focusedOption.value}"`);
          await interaction.respond(filtered.slice(0, 25)); // Discord limits to 25 choices
        } catch (error) {
          logger.error("Error fetching projects for autocomplete:", {
            message: error.message,
            stack: error.stack,
          });
          // Respond with empty array on error, not error message
          await interaction.respond([]);
        }
      }
    } catch (error) {
      logger.error("Autocomplete handler error:", {
        message: error.message,
        stack: error.stack,
      });
      try {
        await interaction.respond([]);
      } catch (respondError) {
        logger.error("Failed to respond to autocomplete:", respondError);
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

      logger.info(`Fetching team activities for ${dateKey} (project: ${projectFilter})`);

      // Step 1: Get all projects and find the selected one
      const projects = await fetchProjects();
      const selectedProject = projects.find(
        (p) =>
          p.name.toLowerCase() === projectFilter.toLowerCase() ||
          p.identifier.toLowerCase() === projectFilter.toLowerCase()
      );

      if (!selectedProject) {
        return interaction.editReply({
          content: `❌ **Project not found**\n\nCould not find project: ${projectFilter}`,
        });
      }

      const projectId = selectedProject.id;
      const projectName = selectedProject.name;
      const projectIdentifier = selectedProject.identifier;

      logger.info(`Found project: ${projectName} (${projectIdentifier})`);

      // Step 2: Get project members (only team members assigned to this project)
      const members = await getProjectMembers(projectId);
      logger.info(`Found ${members.length} members in project ${projectName}`);

      // Step 3: Get cycle information for this project
      const cycles = await getCyclesWithCache(projectId);
      
      // Find the active/current cycle for the date
      const [year, month, day] = dateKey.split('-').map(Number);
      const queryDate = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
      
      const relevantCycles = cycles.filter((c) => {
        if (!c.startDate || !c.endDate) return false;
        const cycleStart = new Date(c.startDate);
        const cycleEnd = new Date(c.endDate);
        return queryDate >= cycleStart && queryDate <= cycleEnd;
      });

      let cycleInfo = "No active cycles";
      if (relevantCycles.length > 0) {
        cycleInfo = relevantCycles
          .map((c) => {
            const totalIssues = c.totalIssues || 0;
            const completedIssues = c.completedIssues || 0;
            const percentage = totalIssues > 0 ? Math.round((completedIssues / totalIssues) * 100) : 0;
            return `${c.name} -> ${percentage}% completed`;
          })
          .join("\n");
      }

      logger.info(`Cycle info: ${cycleInfo}`);

      // Step 4: Clear caches to ensure fresh data
      clearActivityCaches();

      // Step 5: Get activities for ALL team members
      const teamMemberData = [];

      for (const member of members) {
        const userData = member.member || member.user || member;
        const memberName =
          member.display_name ||
          userData.display_name ||
          userData.first_name ||
          userData.email ||
          "Unknown";

        if (memberName === "Unknown") continue;

        logger.info(`Fetching activities for team member: ${memberName}`);

        try {
          // Fetch activities for this specific person
          const personActivities = await getTeamActivities(
            startOfDay,
            endOfDay,
            projectFilter,
            memberName
          );

          if (personActivities.length === 0) {
            logger.info(`No activities found for ${memberName}`);
            continue;
          }

          // Process activities for this person
          const completed = [];
          const inProgress = [];
          const workItemStates = new Map();
          const comments = []; // Store comments for progress tracking

          for (const activity of personActivities) {
            const workItemId = activity.workItem;
            const workItemName = activity.workItemName;

            switch (activity.type) {
              case "activity":
              case "work_item_snapshot":
                const state = activity.newValue || activity.state || "Unknown";
                const activityTime = new Date(activity.time || activity.updatedAt);
                const existing = workItemStates.get(workItemId);

                if (!existing || activityTime > new Date(existing.time)) {
                  workItemStates.set(workItemId, {
                    id: workItemId,
                    name: workItemName,
                    state: state,
                    time: activity.time || activity.updatedAt,
                  });
                }
                break;

              case "comment":
                // Extract comment text - handle both stripped and HTML formats
                const commentText = activity.comment || "";
                if (commentText.trim().length > 0) {
                  // Truncate long comments to 100 chars for summary
                  const truncatedComment = commentText.length > 100 
                    ? commentText.substring(0, 100) + "..." 
                    : commentText;
                  
                  comments.push({
                    id: workItemId,
                    name: workItemName,
                    comment: truncatedComment,
                    actor: activity.actor,
                    time: activity.time,
                  });
                  
                  // Track work item with comment as in-progress (unless already marked as completed)
                  if (!completed.find((c) => c.id === workItemId)) {
                    const existing = inProgress.find((c) => c.id === workItemId);
                    if (!existing) {
                      inProgress.push({
                        id: workItemId,
                        name: workItemName,
                        state: "In Progress (Updated via comment)",
                        hasComments: true,
                      });
                    }
                  }
                }
                break;

              case "subitem":
                const subState = activity.state || "Unknown";
                if (matchesStateCategory(subState, "completed")) {
                  if (!completed.find((c) => c.id === workItemId)) {
                    completed.push({ id: workItemId, name: workItemName });
                  }
                } else {
                  if (!inProgress.find((c) => c.id === workItemId)) {
                    inProgress.push({ id: workItemId, name: workItemName, state: subState });
                  }
                }
                break;

              default:
                break;
            }
          }

          // Categorize work items based on state
          for (const [, workItem] of workItemStates) {
            if (matchesStateCategory(workItem.state, "completed")) {
              if (!completed.find((c) => c.id === workItem.id)) {
                completed.push({ id: workItem.id, name: workItem.name });
              }
            } else {
              if (!inProgress.find((c) => c.id === workItem.id)) {
                inProgress.push({
                  id: workItem.id,
                  name: workItem.name,
                  state: workItem.state,
                });
              }
            }
          }

          // Only add member if they have any activity
          if (completed.length > 0 || inProgress.length > 0 || comments.length > 0) {
            teamMemberData.push({
              name: memberName,
              completed,
              inProgress,
              comments, // Include comments in member data
            });
          }
        } catch (error) {
          logger.warn(`Error fetching activities for ${memberName}: ${error.message}`);
        }
      }

      // Handle no activities case
      if (teamMemberData.length === 0) {
        const embed = new EmbedBuilder()
          .setColor(0x99aab5)
          .setTitle(`📊 Team Daily Summary for ${projectName} (${dateKey})`)
          .setDescription("No team activity found for this period.")
          .setFooter({ text: "0 team members with activity" })
          .setTimestamp();

        return interaction.editReply({ embeds: [embed] });
      }

      // Format team data for Gemini
      const formattedTeamData = teamMemberData
        .map((member) => {
          const completedText =
            member.completed.length > 0
              ? member.completed.map((t) => `  • ${t.id}: ${t.name}`).join("\n")
              : "  None";
          const inProgressText =
            member.inProgress.length > 0
              ? member.inProgress
                  .map((t) => `  • ${t.id}: ${t.name} (${t.state})`)
                  .join("\n")
              : "  None";
          
          // Format comments - extract unique comments by task
          const commentsByTask = {};
          member.comments?.forEach((comment) => {
            if (!commentsByTask[comment.id]) {
              commentsByTask[comment.id] = [];
            }
            commentsByTask[comment.id].push(comment.comment);
          });
          
          const commentsText = Object.keys(commentsByTask).length > 0
            ? Object.entries(commentsByTask)
                .map(([taskId, commentList]) => {
                  const taskName = member.inProgress.find((t) => t.id === taskId)?.name || 
                                   member.completed.find((t) => t.id === taskId)?.name || 
                                   taskId;
                  return `  • ${taskId}: ${commentList[0]}`; // Use first comment as summary
                })
                .join("\n")
            : "  None";

          return `MEMBER: ${member.name}\nCOMPLETED:\n${completedText}\nIN_PROGRESS:\n${inProgressText}\nCOMMENTS:\n${commentsText}`;
        })
        .join("\n\n");

      const userPrompt = DAILY_SUMMARY_PROMPT
        .replace("{{date}}", dateKey)
        .replace("{{projectName}}", projectName)
        .replace("{{cycleInfo}}", cycleInfo)
        .replace("{{teamData}}", formattedTeamData);

      logger.info(
        `Calling Gemini API with ${teamMemberData.length} team members (${userPrompt.length} chars prompt)`
      );

      const geminiStartTime = Date.now();

      // Call Gemini
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
      const title = `📊 Team Daily Summary for ${projectName} (${dateKey})`;

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
            chunk = summaryContent.substring(0, lastNewline);
          }
        }

        const embed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setFooter({
            text: `${teamMemberData.length} team members • Page ${embeds.length + 1}`,
          })
          .setTimestamp();

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
      logger.error("Error generating team daily summary:", error);

      return interaction.editReply({
        content:
          "❌ **Error generating summary**\n\nAn error occurred while generating the summary. Please try again later.",
      });
    }
  },
};
