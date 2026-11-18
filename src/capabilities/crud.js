const normalizeName = value => String(value || '').toLowerCase().replaceAll(/[^a-z0-9]/g, '');
const escapeRegex = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function normalizeOperators(value) {
    if (Array.isArray(value)) return value.map(normalizeOperators);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
        key,
        ['$in', '$nin', '$all'].includes(key) && !Array.isArray(item)
            ? [normalizeOperators(item)]
            : normalizeOperators(item)
    ]));
}

function mergeAppFilter(filter, appFilter) {
    if (!appFilter) return filter;
    return {
        ...filter,
        query: filter.query
            ? { $and: [appFilter, filter.query] }
            : appFilter
    };
}

export function createMcpCrudTool(server) {
    const appCache = new Map();
    const activeAppsByArray = new Map();

    const readApps = async (context, query, limit = 10) => {
        const request = await server.authorize.request({
            method: 'object.read', array: 'apps',
            organization_id: context.organization_id,
            host: context.host,
            apikey: context.apikey,
            filter: { query, key: { _id: 1, name: 1, singularName: 1, path: 1, array: 1, filter: 1 }, limit }
        }, context.user_id);
        return (await server.crud.send(request))?.object ?? [];
    };

    const resolveApp = async (array, context) => {
        if (typeof array !== 'string' || array === 'apps') return;
        const normalized = normalizeName(array);
        if (appCache.has(normalized)) return appCache.get(normalized);

        const exact = `^${escapeRegex(array)}$`;
        const apps = await readApps(context, {
            $or: [
                { name: { $regex: exact, $options: 'i' } },
                { singularName: { $regex: exact, $options: 'i' } },
                { array: { $regex: exact, $options: 'i' } }
            ]
        });
        const app = apps.find(item => [item.name, item.singularName, item.array]
            .flatMap(value => Array.isArray(value) ? value : [value])
            .some(value => normalizeName(value) === normalized));
        appCache.set(normalized, app);
        if (app?.array) {
            for (const item of Array.isArray(app.array) ? app.array : [app.array]) {
                activeAppsByArray.set(normalizeName(item), app);
            }
        }
        return app;
    };

    const resolveAppForArray = async (array, context) => {
        const cached = activeAppsByArray.get(normalizeName(array));
        if (cached) return cached;
        const apps = await readApps(context, { array });
        const app = apps.find(item => (Array.isArray(item.array) ? item.array : [item.array])
            .some(value => value === array));
        if (app) activeAppsByArray.set(normalizeName(array), app);
        return app;
    };

    const normalizeRequest = async (input, context) => {
        if (!input || typeof input !== 'object' || Array.isArray(input) ||
            !/^(storage|database|array|index|object)\.(create|read|update|delete)$/.test(input.method || '')) {
            throw new Error('CRUD accepts CoCreate storage, database, array, index, and object CRUD methods.');
        }
        const { fields, limit, projection, query, skip, sort, ...request } = input;
        if (Array.isArray(request.array) && request.array.length === 1) request.array = request.array[0];
        if (request.array === 'secrets') {
            throw new Error('The MCP CRUD tool does not expose the secrets array. Use configured API credential tools instead.');
        }

        let app;
        if (/^object\./.test(request.method) && typeof request.array === 'string' && request.array !== 'apps') {
            app = activeAppsByArray.get(normalizeName(request.array)) || await resolveApp(request.array, context);
            if (app?.array) {
                const requestedArray = request.array;
                request.array = Array.isArray(app.array) ? app.array[0] : app.array;
                request.app_id = app._id;
                if (app.filter?.query && request.method === 'object.create') {
                    const defaults = Object.fromEntries(Object.entries(app.filter.query)
                        .filter(([, value]) => value === null || ['string', 'number', 'boolean'].includes(typeof value)));
                    request.object = (Array.isArray(request.object) ? request.object : [request.object])
                        .map(record => ({ ...defaults, ...record }));
                } else if (app.filter?.query) {
                    const requestedQuery = request.filter?.query ?? query;
                    request.filter = mergeAppFilter({ ...(request.filter || {}), ...(requestedQuery !== undefined && { query: requestedQuery }) }, app.filter.query);
                }
                request.requestedArray = requestedArray;
            }
        }

        const filter = { ...(request.filter || {}) };
        const requestedProjection = projection ?? fields ?? filter.projection;
        const requestedSkip = skip ?? filter.skip;
        const requestedSort = sort ?? filter.sort;
        const filterOptions = {
            limit,
            key: requestedProjection,
            query,
            index: requestedSkip,
            sort: requestedSort && !Array.isArray(requestedSort)
                ? Object.entries(requestedSort).map(([key, direction]) => ({ key, direction }))
                : requestedSort
        };
        delete filter.projection;
        delete filter.skip;
        for (const [key, value] of Object.entries(filterOptions)) {
            if (value !== undefined && filter[key] === undefined) filter[key] = value;
        }
        if (filter.query) filter.query = normalizeOperators(filter.query);
        if (Object.keys(filter).length) request.filter = filter;
        else delete request.filter;

        const writes = ['object.create', 'object.update'].includes(request.method);
        const records = Array.isArray(request.object) ? request.object : [request.object];
        if (writes && request.array === 'secrets') {
            throw new Error('External API credentials cannot be written to secrets.');
        }
        if (writes && request.array === 'apis' && records.some(record => record && typeof record === 'object' &&
            (Object.hasOwn(record, 'key') || Object.hasOwn(record.$set ?? {}, 'key')))) {
            throw new Error('API keys cannot be written through CRUD.');
        }
        if (writes && request.array === 'endpoints') {
            const required = ['api_id', 'name', 'method', 'endpoint', 'description', 'enabled'];
            const unsupported = ['requestTemplate', 'handler', 'code', 'source', 'route', 'implementation'];
            for (const record of records) {
                const missing = required.filter(key => record?.[key] === undefined);
                const invalid = unsupported.filter(key => record?.[key] !== undefined);
                if (!record || typeof record !== 'object' || missing.length || invalid.length ||
                    typeof record.method !== 'string' || record.method !== record.method.toLowerCase()) {
                    throw new Error('Endpoint records must use the CoCreate API endpoint structure with a lowercase HTTP method; executable code fields are not accepted.');
                }
            }
        }
        if (writes && request.array === 'webhooks') {
            const required = ['api_id', 'path', 'description', 'enabled', 'chunks', 'receive', 'rawBody'];
            for (const record of records) {
                if (!record || typeof record !== 'object' || required.some(key => record[key] === undefined) ||
                    (!record.process && !record.action) || !Array.isArray(record.chunks) ||
                    !record.receive || typeof record.receive !== 'object' ||
                    !record.rawBody || typeof record.rawBody !== 'object') {
                    throw new Error('Webhook records must use the configured CoCreate webhook AST structure.');
                }
            }
        }
        return request;
    };

    return {
        name: 'crud',
        title: 'CoCreate CRUD',
        description: 'Read, create, update, or delete CoCreate data. App names and singular names are resolved through apps records and their filters/defaults are applied.',
        inputSchema: {
            type: 'object',
            properties: {
                method: { type: 'string', pattern: '^(storage|database|array|index|object)\\.(create|read|update|delete)$' },
                array: { description: 'CoCreate array name or an app name/singular name.' },
                object: {}, filter: { type: 'object' }, storage: { type: 'string' }, database: { type: 'string' },
                query: {}, fields: {}, projection: {}, limit: { type: 'integer' }, skip: { type: 'integer' }, sort: {}
            },
            required: ['method'],
            additionalProperties: true
        },
        authorize: async (input, context) => {
            const request = await normalizeRequest(input, context);
            const { organization_id: _organizationId, host: _host, apikey: _apikey, user_id: _userId, ...operation } = request;
            return { ...operation, organization_id: context.organization_id, host: context.host, apikey: context.apikey };
        },
        handler: async (request, context) => {
            const { requestedArray, ...operation } = request;
            const response = await server.crud.send(operation);
            const resultKey = operation.method.split('.')[0];
            const items = response?.[resultKey];
            if (operation.method === 'object.read' && operation.array === 'apps' && Array.isArray(items)) {
                for (const app of items) {
                    for (const name of [app.name, app.singularName]) if (name) appCache.set(normalizeName(name), app);
                    for (const array of Array.isArray(app.array) ? app.array : [app.array]) if (array) activeAppsByArray.set(normalizeName(array), app);
                }
            }
            let app;
            if (operation.array && operation.array !== 'apps') {
                try {
                    app = activeAppsByArray.get(normalizeName(operation.array)) || await resolveAppForArray(operation.array, context);
                } catch { /* Object results remain usable if app metadata is not readable. */ }
            }
            const excluded = ['apps', 'apis', 'endpoints', 'webhooks', 'ai-instructions'];
            const references = operation.method.startsWith('object.') && Array.isArray(items) && !excluded.includes(operation.array)
                ? items.filter(item => item?._id).map(item => ({
                    method: operation.method,
                    filter: operation.filter || {},
                    ...(app?._id && { app_id: app._id }),
                    ...(app?.path && { app_path: app.path }),
                    ...(operation.storage !== undefined && { storage: operation.storage }),
                    ...(operation.database !== undefined && { database: operation.database }),
                    array: operation.array,
                    object: item._id,
                    key: '{}',
                    language: 'json'
                }))
                : undefined;
            return {
                ...response,
                ...(requestedArray && requestedArray !== operation.array && { requestedArray }),
                ...(references?.length && { references })
            };
        }
    };
}

export function createAppTools(server) {
    return [
        {
            name: 'list_apps',
            description: 'Discover CoCreate app records, their names, singular names, physical arrays, filters, and app paths. Use this to map an application concept to its stored data.',
            inputSchema: {
                type: 'object', properties: { search: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 } },
                additionalProperties: false
            },
            authorize: async (input, context) => {
                const filter = { enabled: { $ne: false } };
                if (input.search) {
                    const exact = `.*${escapeRegex(input.search)}.*`;
                    filter.$or = [
                        { name: { $regex: exact, $options: 'i' } },
                        { singularName: { $regex: exact, $options: 'i' } },
                        { array: { $regex: exact, $options: 'i' } }
                    ];
                }
                return { method: 'object.read', array: 'apps', filter: { query: filter, limit: Math.min(Math.max(input.limit || 50, 1), 100) }, organization_id: context.organization_id, host: context.host, apikey: context.apikey };
            },
            handler: async request => {
                const response = await server.crud.send(request);
                return { apps: (response?.object ?? []).map(({ _id, name, singularName, array, path, description, filter }) => ({ _id, name, singularName, array, path, description, filter })) };
            }
        }
    ];
}
