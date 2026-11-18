/********************************************************************************
 * Copyright (C) 2026 CoCreate and Contributors.
 *
 * Licensed under GNU AGPLv3.
 ********************************************************************************/

/**
 * Creates a conversation-scoped history lookup tool.
 *
 * Organization and conversation boundaries are captured from the authenticated
 * request and never accepted from model-provided arguments.
 * @private
 * @environment server
 */
export function createHistoryTool({ crud, organization_id, host, conversation_id }) {
  return {
    name: 'search_conversation_history',

    handler: async ({ query, limit = 12, skip = 0 } = {}) => {
      const safeLimit = Math.min(Math.max(Number(limit) || 12, 1), 20);
      const safeSkip = Math.max(Number(skip) || 0, 0);
      const filterQuery = { conversation_id };

      if (query) {
        const literalQuery = String(query)
          .slice(0, 200)
          .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        filterQuery.content = {
          $regex: literalQuery,
          $options: 'i'
        };
      }

      const response = await crud.send({
        method: 'object.read',
        array: 'ai-messages',
        organization_id,
        host,
        filter: {
          query: filterQuery,
          key: { role: 1, content: 1 },
          sort: [{ key: '_id', direction: -1 }],
          index: safeSkip,
          limit: safeLimit
        }
      });

      return {
        messages: (response.object ?? []).reverse().map(({ role, content }) => ({
          role,
          content
        })),
        skip: safeSkip,
        limit: safeLimit,
        count: response.filter?.count
      };
    }
  };
}
