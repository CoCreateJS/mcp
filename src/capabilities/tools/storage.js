import { platformAccessError } from '../platform.js';

/**
 * Exposes server.storage to platform AI requests.
 * @private
 * @environment server
 */
export function createStorageTool({ server }) {
  const storage = server.storage;

  return {
    name: 'manage_server_storage',

    handler: async ({ action, key, value }, context = {}) => {
      const denied = platformAccessError(server, context?.organization_id);
      if (denied) return denied;

      switch (action) {
        case 'get':
          return storage.get(key);
        case 'set':
          return storage.set(key, value);
        case 'delete':
          return storage.delete(key);
        case 'size':
          return storage.size();
        case 'clear':
          return storage.clear();
        default:
          throw new Error(`Unsupported storage action: ${action}`);
      }
    }
  };
}
