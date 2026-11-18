/********************************************************************************
 * Copyright (C) 2026 CoCreate and Contributors.
 *
 * Licensed under GNU AGPLv3.
 ********************************************************************************/

/**
 * Creates the bridge to server.api.send(data).
 *
 * The authenticated organization and host are captured per AI session and
 * written after model-provided values so they cannot be overridden.
 *
 * @param {Object} options
 * @param {Object} options.server - CoCreateServer instance
 * @param {string} options.organization_id - Authenticated request organization
 * @param {string} [options.host] - Authenticated request host
 * @returns {Object} API tool definition
 * @private
 * @environment server
 */
export function createApiTool({ server, organization_id, host }) {
  return {
    name: 'execute_server_api',

    handler: async (input = {}) => {
      if (typeof organization_id !== 'string' || !organization_id.trim()) {
        return { success: false, error: 'An authenticated organization_id is required for API calls.' };
      }
      const api = server.api;
      if (typeof api?.send !== 'function') {
        throw new Error('The CoCreate server API capability is not initialized.');
      }
      const {
        organization_id: _ignoredOrganizationId,
        host: _ignoredHost,
        ...apiPayload
      } = input;

      return api.send({
        ...apiPayload,
        organization_id,
        host
      });
    }
  };
}
