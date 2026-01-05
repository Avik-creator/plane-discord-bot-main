/**
 * API client initialization and configuration
 */

import axios from "axios";
import logger from "../../utils/logger.js";

let serviceConfig = null;
let PLANE_API = null;

/**
 * Initialize the Plane API client with configuration
 * @param {Object} config - Configuration object with API credentials
 */
function initPlaneService(config) {
  serviceConfig = config;
  PLANE_API = axios.create({
    baseURL: serviceConfig.PLANE_BASE_URL,
    headers: {
      "X-API-KEY": serviceConfig.PLANE_API_KEY,
      "Content-Type": "application/json",
    },
    timeout: 45000,
  });
  logger.info("Plane service initialized");
}

/**
 * Ensures the API client is initialized
 * @throws {Error} If API client is not initialized
 */
function ensureApi() {
  if (!PLANE_API) {
    throw new Error("Plane API service not initialized. Call initPlaneService(config) first.");
  }
}

/**
 * Get the API client instance
 * @returns {Object} Axios instance for API calls
 */
function getApiClient() {
  ensureApi();
  return PLANE_API;
}

/**
 * Get the service configuration
 * @returns {Object} Service configuration
 */
function getServiceConfig() {
  ensureApi();
  return serviceConfig;
}

export { initPlaneService, ensureApi, getApiClient, getServiceConfig };
