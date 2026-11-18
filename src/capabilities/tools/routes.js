import { platformAccessError } from '../platform.js';

/**
 * Factory creating platform custom route management tool for server.routes.
 *
 * @param {Object} options
 * @param {Object} options.server - Server context instance
 * @returns {Object} Route management copilot tool definition
 * @private
 * @environment server
 */
export function createRouteTool({ server }) {
  const routes = server.routes;

  return {
    name: 'manage_server_routes',

    handler: async ({ action, routePath, responseContent, contentType = 'text/plain' }, context = {}) => {
      const denied = platformAccessError(server, context?.organization_id);
      if (denied) return denied;

      if (action === 'list') {
        const activeRoutes = Array.from(routes.keys());
        return { success: true, routes: activeRoutes, count: activeRoutes.length };
      }

      if (action === 'add') {
        if (!routePath) return { success: false, error: 'routePath is required when adding a route.' };

        const customHandler = async (req, res) => {
          res.writeHead(200, { 'Content-Type': contentType });
          res.end(typeof responseContent === 'object' ? JSON.stringify(responseContent) : responseContent ?? 'OK');
        };

        routes.set(routePath, customHandler);
        return { success: true, message: `Route "${routePath}" successfully registered.`, routePath };
      }

      if (action === 'remove') {
        if (!routePath) return { success: false, error: 'routePath is required when removing a route.' };
        const removed = routes.delete(routePath);
        return { success: removed, message: removed ? `Route "${routePath}" removed.` : `Route "${routePath}" not found.` };
      }

      return { success: false, error: `Invalid action: ${action}` };
    }
  };
}
