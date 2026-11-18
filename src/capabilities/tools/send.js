import { platformAccessError } from '../platform.js';

/**
 * Creates the bridge to CoCreateServer's unified server.send(payload) router.
 *
 * The organization is captured from the authenticated AI request and injected
 * after model-provided fields so it cannot be overridden.
 *
 * @param {Object} options
 * @param {Object} options.server - CoCreateServer instance
 * @param {string} options.organization_id - Authenticated request organization
 * @returns {Object} Copilot tool definition for send_server_message
 * @private
 * @environment server
 */
export function createSendTool({ server, organization_id }) {
  return {
    name: 'send_server_message',

    handler: async (payload) => {
      const denied = platformAccessError(server, organization_id);
      if (denied) return denied;
      const routedPayload = {
        ...payload,
        organization_id
      };

      await server.send(routedPayload);
      return routedPayload;
    }
  };
}
