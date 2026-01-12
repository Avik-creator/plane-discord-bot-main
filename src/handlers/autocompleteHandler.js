import { getPeople } from '../services/personDailySummary.js';
import { fetchProjects } from '../services/planeApiDirect.js';
import logger from '../utils/logger.js';

/**
 * Handle autocomplete interactions
 * @param {Object} interaction - Discord interaction object
 * @returns {Object} Autocomplete response
 */
export async function handleAutocomplete(interaction) {
  const { name, options } = interaction.data;
  const focusedOption = options?.find(o => o.focused);

  if (!focusedOption) {
    return { type: 8, data: { choices: [] } }; // APPLICATION_COMMAND_AUTOCOMPLETE_RESULT
  }

  try {
    if (name === 'person_daily_summary' && focusedOption.name === 'person') {
      return await handlePersonAutocomplete(focusedOption.value);
    }

    if (name === 'person_daily_summary' && focusedOption.name === 'team') {
      return await handleProjectAutocomplete(focusedOption.value);
    }

    if (name === 'team_daily_summary' && focusedOption.name === 'project') {
      return await handleProjectAutocomplete(focusedOption.value);
    }

  } catch (error) {
    logger.error(`Error in autocomplete for ${name}.${focusedOption.name}:`, error);
    return {
      type: 8, // APPLICATION_COMMAND_AUTOCOMPLETE_RESULT
      data: { choices: [{ name: "Error loading data", value: "error" }] }
    };
  }

  // Default empty response
  return { type: 8, data: { choices: [] } };
}

/**
 * Handle person autocomplete for person_daily_summary command
 * @param {string} query - Search query
 * @returns {Object} Autocomplete response
 */
async function handlePersonAutocomplete(query) {
  logger.debug(`Autocomplete for person_daily_summary person: "${query}"`);
  const people = await getPeople();
  logger.debug(`Fetched ${people.length} people for person_daily_summary autocomplete`);

  if (!people || people.length === 0) {
    logger.warn("No people available for person_daily_summary autocomplete");
    return {
      type: 8,
      data: { choices: [{ name: "No people found", value: "none" }] }
    };
  }

  const focusedValue = query?.toLowerCase() || '';

  const filtered = people
    .filter(p => {
      if (!p || !p.name) return false;
      if (!focusedValue) return true; // Show all if no input
      return p.name.toLowerCase().includes(focusedValue);
    })
    .slice(0, 25)
    .map(p => ({ name: p.name, value: p.name }));

  logger.debug(`Returning ${filtered.length} filtered people for person_daily_summary`);

  if (filtered.length === 0) {
    return {
      type: 8,
      data: { choices: [{ name: `No people match "${focusedValue}"`, value: "no_match" }] }
    };
  }

  return {
    type: 8,
    data: { choices: filtered }
  };
}

/**
 * Handle project autocomplete for both commands
 * @param {string} query - Search query
 * @returns {Object} Autocomplete response
 */
async function handleProjectAutocomplete(query) {
  logger.debug(`Autocomplete for project: "${query}"`);
  const allProjects = await fetchProjects();
  logger.debug(`Fetched ${allProjects.length} projects for autocomplete`);

  if (!allProjects || allProjects.length === 0) {
    logger.warn("No projects available for autocomplete");
    return {
      type: 8,
      data: { choices: [{ name: "No projects found", value: "none" }] }
    };
  }

  // Filter to only show specific projects: Radar(RADAR), Forga(FORGE), SLM - Radar Agent(SLMRA), HSBC Smart Splunk(HSBCS)
  const allowedProjectIdentifiers = ['RADAR', 'FORGE', 'SLMRA', 'HSBCS'];
  const projects = allProjects.filter(project => allowedProjectIdentifiers.includes(project.identifier));

  logger.debug(`Filtered to ${projects.length} allowed projects for autocomplete`);

  const focusedValue = query?.toLowerCase() || '';

  const filtered = projects
    .filter(p => {
      if (!p) return false;
      if (!focusedValue) return true; // Show all if no input

      const nameMatch = p.name?.toLowerCase().includes(focusedValue);
      const identifierMatch = p.identifier?.toLowerCase().includes(focusedValue);
      return nameMatch || identifierMatch;
    })
    .filter(p => p.identifier || p.id) // Ensure we have a value for autocomplete
    .slice(0, 25)
    .map(p => ({
      name: `${p.name || "Unknown"} (${p.identifier || "no-id"})`.substring(0, 100),
      value: String(p.identifier || p.id)
    }));

  logger.debug(`Returning ${filtered.length} filtered projects`);

  if (filtered.length === 0) {
    return {
      type: 8,
      data: { choices: [{ name: `No projects match "${focusedValue}"`, value: "no_match" }] }
    };
  }

  return {
    type: 8,
    data: { choices: filtered }
  };
}
