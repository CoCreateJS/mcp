import { platformAccessError } from '../platform.js';

/**
 * Exposes the actual server.autoscaler interface to platform AI requests.
 * @private
 * @environment server
 */
export function createAutoscalerTool({ server }) {
  const autoscaler = server.autoscaler;

  return {
    name: 'manage_server_autoscaler',

    handler: async ({ action, value }, context = {}) => {
      const denied = platformAccessError(server, context?.organization_id);
      if (denied) return denied;

      switch (action) {
        case 'getConfig':
          return autoscaler.config;
        case 'determineScaleOutTarget':
          return autoscaler.determineScaleOutTarget(value);
        case 'scaleOut':
          return autoscaler.scaleOut(value);
        case 'determineScaleInTarget':
          return autoscaler.determineScaleInTarget(value);
        case 'scaleIn':
          return autoscaler.scaleIn(value);
        default:
          throw new Error(`Unsupported autoscaler action: ${action}`);
      }
    }
  };
}
