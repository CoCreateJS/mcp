/********************************************************************************
 * Copyright (C) 2026 CoCreate and Contributors.
 *
 * Licensed under GNU AGPLv3.
 ********************************************************************************/

/**
 * Creates the generic bridge to CoCreate's unified CRUD payload contract.
 *
 * The organization is captured from the authenticated AI request when the tool
 * is created. It is intentionally absent from the model-facing schema and is
 * always written after the model-provided payload so it cannot be overridden.
 *
 * @param {Object} options
 * @param {Object} options.crud - CoCreate CRUD service
 * @param {string} options.organization_id - Authenticated tenant organization
 * @param {string} [options.host] - Authenticated request host
 * @returns {Object} Copilot tool definition for crud
 * @private
 * @environment server
 */
export function createCrudTool({ crud, organization_id, host }) {
  const appResolutions = new Map();
  const activeAppsByArray = new Map();
  const normalizeResourceName = (value) => String(value || '')
    .toLowerCase()
    .replaceAll(/[^a-z0-9]/g, '');
  const escapeRegExp = (value) => String(value)
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const normalizeQueryOperators = (value) => {
    if (Array.isArray(value)) return value.map(normalizeQueryOperators);
    if (!value || typeof value !== 'object') return value;

    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (['$in', '$nin', '$all'].includes(key) && !Array.isArray(item)) {
        return [key, [normalizeQueryOperators(item)]];
      }
      return [key, normalizeQueryOperators(item)];
    }));
  };

  const resolveApp = async (array) => {
    if (typeof array !== 'string' || array === 'apps') return;
    const normalized = normalizeResourceName(array);
    if (appResolutions.has(normalized)) return appResolutions.get(normalized);

    const exact = `^${escapeRegExp(array)}$`;
    const response = await crud.send({
      method: 'object.read',
      array: 'apps',
      organization_id,
      host,
      filter: {
        query: {
          $or: [
            { name: { $regex: exact, $options: 'i' } },
            { singularName: { $regex: exact, $options: 'i' } }
          ]
        },
        key: {
          _id: 1,
          name: 1,
          singularName: 1,
          array: 1,
          filter: 1
        },
        limit: 5
      }
    });
    const app = (response?.object || []).find((candidate) =>
      [candidate.name, candidate.singularName]
        .some((value) => normalizeResourceName(value) === normalized)
    );
    appResolutions.set(normalized, app);
    if (app?.array && typeof app.array === 'string') {
      activeAppsByArray.set(normalizeResourceName(app.array), app);
    }
    return app;
  };

  return {
    name: 'crud',

    handler: async (payload) => {
      if (typeof organization_id !== 'string' || !organization_id.trim()) {
        return { success: false, error: 'An authenticated organization_id is required for CRUD.' };
      }
      if (!/^(storage|database|array|index|object)\.(create|read|update|delete)$/.test(payload?.method ?? '')) {
        return { success: false, error: 'The CRUD tool accepts only CRUD methods; use the scoped API tool for API calls.' };
      }
      const {
        fields,
        limit,
        projection,
        query,
        skip,
        sort,
        ...request
      } = payload;
      if (/^object\.(create|read|update|delete)$/.test(request.method ?? '')) {
        // A single logical target is equivalent whether supplied as a scalar or
        // a one-item array. Normalize it so app aliases such as Leads still
        // resolve to their physical array and discriminator.
        if (Array.isArray(request.array) && request.array.length === 1) {
          request.array = request.array[0];
          payload.array = request.array;
        }
        const app = activeAppsByArray.get(normalizeResourceName(request.array)) ||
          await resolveApp(request.array);
        if (app?.array) {
          request.array = app.array;
          payload.array = app.array;
          payload.app_id = app._id;
          if (app.filter?.query && request.method === 'object.create') {
            const defaults = Object.fromEntries(
              Object.entries(app.filter.query).filter(([, value]) =>
                value === null || ['string', 'number', 'boolean'].includes(typeof value)
              )
            );
            request.object = (Array.isArray(request.object)
              ? request.object
              : [request.object]
            ).map((object) => ({ ...defaults, ...object }));
          } else if (app.filter?.query) {
            const requestedQuery = request.filter?.query ?? query;
            request.filter = {
              ...request.filter,
              query: requestedQuery
                ? { $and: [app.filter.query, requestedQuery] }
                : app.filter.query
            };
          }
        }
      }
      const filter = { ...request.filter };
      const requestedProjection = projection ?? fields ?? filter.projection;
      const requestedSkip = skip ?? filter.skip;
      const requestedSort = sort ?? filter.sort;
      const filterOptions = {
        limit,
        key: requestedProjection,
        query,
        index: requestedSkip,
        sort: requestedSort && !Array.isArray(requestedSort)
          ? Object.entries(requestedSort).map(([key, direction]) => ({
              key,
              direction
            }))
          : requestedSort
      };

      const isWrite = /^object\.(create|update)$/.test(request.method ?? '');
      const objects = Array.isArray(request.object) ? request.object : [request.object];
      const writesApiKey = objects.some((object) =>
        object && typeof object === 'object' &&
        (Object.hasOwn(object, 'key') || Object.hasOwn(object.$set ?? {}, 'key'))
      );

      if (isWrite && request.array === 'secrets') {
        throw new Error(
          'External API credentials must not be stored in secrets. Create or update the provider record in apis, then use request_api_credential to show the mapped credential card.'
        );
      }

      if (isWrite && request.array === 'apis' && writesApiKey) {
        throw new Error(
          'Do not write apis.key through crud. Use request_api_credential so the key is saved through the mapped credential card without entering chat or tool payloads.'
        );
      }

      const requiresCompleteRecord = isWrite;
      if (requiresCompleteRecord && request.array === 'endpoints') {
        const required = ['api_id', 'name', 'method', 'endpoint', 'description', 'enabled'];
        const unsupported = [
          'requestTemplate',
          'handler',
          'code',
          'source',
          'route',
          'implementation'
        ];
        for (const object of objects) {
          const missing = required.filter((key) => object?.[key] === undefined);
          const invalid = unsupported.filter((key) => object?.[key] !== undefined);
          if (missing.length) {
            throw new Error(
              `Invalid CoCreate endpoint record. Missing ${missing.join(', ')}. ` +
              'Use the executable apps/apis endpoint structure: api_id, name, lowercase method, endpoint (string or AST object), description, optional actions/data/searchParams/headers, and enabled.'
            );
          }
          if (invalid.length) {
            throw new Error(
              `Invalid CoCreate endpoint record. Unsupported fields: ${invalid.join(', ')}. ` +
              'Represent provider request content in data and executable steps in actions using the apps/apis AST structure.'
            );
          }
          if (typeof object.method !== 'string' || object.method !== object.method.toLowerCase()) {
            throw new Error('Invalid CoCreate endpoint record. method must be a lowercase HTTP method.');
          }
        }
      }

      if (requiresCompleteRecord && request.array === 'webhooks') {
        const required = [
          'api_id',
          'path',
          'description',
          'enabled',
          'chunks',
          'receive',
          'rawBody'
        ];
        for (const object of objects) {
          const missing = required.filter((key) => object?.[key] === undefined);
          if (missing.length || (!object?.process && !object?.action)) {
            const details = [
              ...(missing.length ? [`missing ${missing.join(', ')}`] : []),
              ...(!object?.process && !object?.action ? ['missing executable process or action'] : [])
            ];
            throw new Error(
              `Invalid CoCreate webhook record: ${details.join('; ')}. ` +
              'Use the executable apps/apis webhook AST structure with chunks, receive, rawBody, provider verification when required, an action/process, and response handling.'
            );
          }
          if (!Array.isArray(object.chunks) || typeof object.receive !== 'object' ||
              typeof object.rawBody !== 'object') {
            throw new Error(
              'Invalid CoCreate webhook record. chunks must be an array, and receive/rawBody must be executable AST objects matching apps/apis/webhooks/config/data.js.'
            );
          }
        }
      }

      delete filter.projection;
      delete filter.skip;

      for (const [key, value] of Object.entries(filterOptions)) {
        if (value !== undefined && filter[key] === undefined) {
          filter[key] = value;
        }
      }
      if (filter.query) filter.query = normalizeQueryOperators(filter.query);

      const response = await crud.send({
        ...request,
        ...(Object.keys(filter).length && { filter }),
        organization_id,
        host
      });
      const responseKey = request.method?.split('.')[0];
      const errors = Array.isArray(response?.error)
        ? response.error
        : response?.error ? [response.error] : [];
      const responseItems = responseKey ? response?.[responseKey] : undefined;

      if (
        request.method === 'object.read' &&
        request.array === 'apps' &&
        Array.isArray(responseItems) &&
        responseItems.length === 1
      ) {
        let [app] = responseItems;
        if (app?._id && (!Object.hasOwn(app, 'array') || !Object.hasOwn(app, 'filter'))) {
          const appResponse = await crud.send({
            method: 'object.read',
            array: 'apps',
            organization_id,
            host,
            filter: {
              query: { _id: app._id },
              key: {
                _id: 1,
                name: 1,
                singularName: 1,
                array: 1,
                filter: 1
              },
              limit: 1
            }
          });
          const hydrated = appResponse?.object?.[0];
          if (hydrated) app = { ...app, ...hydrated };
        }
        for (const name of [app.name, app.singularName]) {
          if (name) appResolutions.set(normalizeResourceName(name), app);
        }
        if (typeof app.array === 'string') {
          activeAppsByArray.set(normalizeResourceName(app.array), app);
        }
      }

      if (errors.length && (!Array.isArray(responseItems) || !responseItems.length)) {
        throw new Error(errors
          .map((error) => error?.message || String(error))
          .join('; '));
      }

      if (responseKey && response?.[responseKey] !== undefined) {
        return {
          [responseKey]: response[responseKey],
          ...(response?.filter && { filter: response.filter }),
          ...(errors.length && { error: errors })
        };
      }

      return { data: response?.data };
    }
  };
}
