import { platformAccessError } from '../platform.js';

/**
 * @file src/tools/servers.js
 * Tool interface for inspecting cluster topology and controlling server state.
 * Topology comes from the 'servers' CRUD collection populated by
 * @cocreate/cluster's state.save()/getServerObject(). Controls use server.send().
 * @environment server
 */

/**
 * Factory creating the manage_server_cluster tool definition.
 *
 * @param {Object} options
 * @param {Object} options.server - Server context instance containing server.crud
 * @returns {Object} Copilot tool definition for manage_server_cluster
 * @private
 * @environment server
 */
export function createServerClusterTool({ server }) {
  const crud = server.crud;

  return {
    name: 'manage_server_cluster',

    handler: async ({
      action,
      serverId,
      host,
      status,
      limit = 50,
      operation,
      worker,
      value,
      organizations
    }, context = {}) => {
      const denied = platformAccessError(server, context?.organization_id);
      if (denied) return denied;

      switch (action) {
          case 'self': {
            return {
              success: true,
              action: 'self',
              server: {
                _id: server.id,
                host: server.host,
                ip: server.ip,
                isPrimary: server.isPrimary,
                isWorker: server.isWorker,
                workerId: server.workerId,
                totalWorkers: server.workers.size,
                deployment: server.deployment,
                isCordoned: server.state.isCordon,
                isShedding: server.state.isShedding,
                isDraining: server.state.isDraining
              }
            };
          }

          case 'get': {
            if (!serverId && !host) {
              return { success: false, error: 'Either "serverId" or "host" is required for get action.' };
            }

            const query = serverId ? { _id: serverId } : { host };
            const response = await crud.send({
              method: 'object.read',
              array: 'servers',
              organization_id: context.organization_id,
              filter: { query, limit: 1 }
            });

            const found = response.object[0];
            return { success: true, action: 'get', server: found };
          }

          case 'list': {
            const query = status ? { status } : {};
            const response = await crud.send({
              method: 'object.read',
              array: 'servers',
              organization_id: context.organization_id,
              filter: { query, limit }
            });

            const servers = response.object;
            return { success: true, action: 'list', count: servers.length, servers };
          }

          case 'control': {
            if (!serverId) {
              return { success: false, error: '"serverId" is required for control actions.' };
            }

            const workerOperations = new Set(['cordon', 'shed', 'drain']);
            const primaryOperations = new Set(['reboot', 'shutdown']);
            const supported = new Set([
              ...workerOperations,
              ...primaryOperations,
              'restart'
            ]);
            if (!supported.has(operation)) {
              return { success: false, error: `Unsupported server control operation: ${operation}` };
            }
            if (workerOperations.has(operation) && worker == null) {
              return { success: false, error: `"worker" is required for ${operation}.` };
            }
            if (operation === 'shed' && organizations === undefined) {
              return {
                success: false,
                error: '"organizations" must be an organization ID, an array of IDs, or false for shed.'
              };
            }

            const payload = {
              method: operation,
              server: serverId,
              organization_id: context.organization_id
            };

            if (worker != null) payload.worker = worker;
            if (operation === 'cordon' || operation === 'drain') {
              payload.value = value !== false;
            }
            if (operation === 'shed') payload.organizations = organizations;
            if (primaryOperations.has(operation) || (operation === 'restart' && worker == null)) {
              payload.primary = true;
            }

            await server.send(payload);
            return { success: true, action: 'control', operation, payload };
          }

        default:
          throw new Error(`Unsupported cluster action: ${action}`);
      }
    }
  };
}
