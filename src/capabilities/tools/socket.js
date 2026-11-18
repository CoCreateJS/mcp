/**
 * Factory creating dedicated WebSocket messaging tool for direct client transmission.
 *
 * @param {Object} options
 * @param {Object} options.server - Server context instance
 * @returns {Object} Socket tool definition
 * @private
 * @environment server
 */
export function createSocketTool({ server }) {

  return {
    name: 'send_socket_message',

    handler: async ({ data = {}, clientId, broadcast = false }, context) => {
      const targetClientId = context.clientId ?? clientId;

      if (!broadcast && !targetClientId) {
        throw new Error('clientId is required unless broadcast is true.');
      }

      const payload = {
        ...data,
        organization_id: context.organization_id,
        ...(targetClientId ? { clientId: targetClientId } : {}),
        ...(context.user_id ? { user_id: context.user_id } : {}),
        broadcast: broadcast === true,
        log: data.log ?? false
      };

      await server.send(payload);
      return payload;
    }
  };
}
