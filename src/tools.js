const object = (properties, required = []) => ({
    type: 'object', properties, required, additionalProperties: false
});

const string = { type: 'string' };

function getPath(value, pathname) {
    return pathname.split('.').reduce((current, key) => current?.[key], value);
}

function trusted(context, payload) {
    const { organization_id: _organizationId, host: _host, apikey: _apikey, user_id: _userId, ...operation } = payload;
    return {
        ...operation,
        organization_id: context.organization_id,
        host: context.host,
        apikey: context.apikey,
        ...(context.user_id && { user_id: context.user_id })
    };
}

async function authorize(server, context, payload) {
    return server.authorize.request(trusted(context, payload), context.user_id);
}

async function sendCrud(server, context, payload) {
    const authorized = await authorize(server, context, payload);
    return server.crud.send(authorized);
}

function isPlatform(server, context) {
    return Boolean(server.organization_id && server.organization_id === context.organization_id);
}

function requirePlatform(server, context) {
    if (!isPlatform(server, context)) {
        throw new Error('This tool is restricted to the CoCreate platform organization.');
    }
}

function tool(name, description, inputSchema, authorizeInput, handler) {
    return {
        name, description, inputSchema,
        authorize: authorizeInput,
        handler
    };
}

/** Built-in CoCreate tools that mirror the shared Server AI service surface. */
export function createBuiltInTools(server, { mcpPath = '/mcp' } = {}) {
    const tools = [];

    tools.push(tool(
        'execute_server_api',
        'Call a configured CoCreate API. The API method and endpoint permissions are checked for the authenticated CoCreate account or API key.',
        { type: 'object', properties: { method: string, api: string, endpoint: string, url: string, data: {}, searchParams: {}, headers: {}, timeout: { type: 'number' } }, required: ['method'], additionalProperties: true },
        input => {
            if (typeof input.method !== 'string' || !input.method.trim()) throw new Error('A configured API method is required.');
            return input;
        },
        async (request, context) => {
            if (typeof server.api?.send !== 'function') throw new Error('The CoCreate API service is not initialized.');
            return server.api.send(trusted(context, request));
        }
    ));

    tools.push(tool(
        'run_workflow',
        'Run a named, configured CoCreate workflow. The workflow method must be authorized for the authenticated CoCreate account or API key.',
        object({ method: string, data: {}, input: {} }, ['method']),
        input => {
            if (typeof input.method !== 'string' || !/^workflow\.[A-Za-z0-9_-]+$/.test(input.method)) {
                throw new Error('method must name a workflow, for example workflow.sendEmail.');
            }
            return input;
        },
        async (request, context) => {
            if (typeof server.workflow?.run !== 'function') throw new Error('The CoCreate workflow service is not initialized.');
            return server.workflow.run(trusted(context, request));
        }
    ));

    tools.push(tool(
        'get_ai_instructions',
        'Retrieve named CoCreate AI operating instructions with examples and referenced source files.',
        object({ name: string }, ['name']),
        input => ({ method: 'object.read', array: 'ai-instructions', filter: { query: { name: input.name, enabled: true }, limit: 1 } }),
        async (request, context) => {
            const result = await server.crud.send(request);
            const instruction = result?.object?.[0];
            if (!instruction) return { error: `No AI instructions found with name "${request.filter.query.name}".` };
            const sources = [];
            for (const source of instruction.sources ?? []) {
                const pathname = source.pathname ?? source.path;
                if (!pathname) {
                    sources.push({ ...source, found: false });
                    continue;
                }
                const fileResponse = await sendCrud(server, context, {
                    method: 'object.read', array: 'files',
                    filter: { query: { $or: [{ pathname }, { path: pathname }] }, limit: 1 }
                });
                const file = fileResponse?.object?.[0];
                sources.push(file
                    ? { ...source, name: source.name ?? file.name, pathname: file.pathname ?? file.path ?? pathname, content: file.src ?? file.content ?? '', contentType: file['content-type'], updated: file.updated, found: true }
                    : { ...source, pathname, found: false });
            }
            return {
                name: instruction.name,
                description: instruction.description,
                instructions: instruction.instructions ?? instruction.content ?? '',
                examples: instruction.examples ?? [],
                sources
            };
        }
    ));

    tools.push(tool(
        'read_reference',
        'Resolve a CoCreate object reference returned by a previous read, including one selected field or full details.',
        object({ array: string, object: string, key: string, storage: string, database: string }, ['array', 'object']),
        input => ({
            method: 'object.read', array: input.array,
            ...(input.storage !== undefined && { storage: input.storage }),
            ...(input.database !== undefined && { database: input.database }),
            filter: { query: { _id: input.object }, ...(input.key ? { key: { [input.key]: 1, _id: 1 } } : {}), limit: 1 }
        }),
        async request => {
            const result = await server.crud.send(request);
            const record = result?.object?.[0];
            if (!record) return { error: 'The referenced CoCreate object was not found.' };
            return request.filter.key && Object.keys(request.filter.key).length > 1
                ? { array: request.array, object: record._id, key: Object.keys(request.filter.key).find(key => key !== '_id'), value: getPath(record, Object.keys(request.filter.key).find(key => key !== '_id')) }
                : { array: request.array, object: record._id, details: record };
        }
    ));

    tools.push(tool(
        'send_socket_message',
        'Send a CoCreate message to the authenticated client or an explicitly addressed client in this tenant.',
        object({ data: { type: 'object' }, clientId: string, broadcast: { type: 'boolean' } }, ['data']),
        input => {
            if (typeof input.data?.method !== 'string' || !input.data.method.trim()) throw new Error('data.method is required so the message can be authorized.');
            return { ...input.data, clientId: input.clientId, broadcast: input.broadcast };
        },
        async (request, context) => {
            if (typeof server.send !== 'function') throw new Error('The CoCreate server message service is not initialized.');
            const payload = trusted(context, { ...request, broadcast: request.broadcast === true, log: request.log ?? false });
            await server.send(payload);
            return { success: true, sent: true };
        }
    ));

    const serverTool = (name, service, description, properties, actions, handler) => tools.push(tool(
        name,
        `${description} Platform organization only.`,
        object({ service: { type: 'string', enum: [service] }, action: { type: 'string', enum: actions }, ...properties }, ['action']),
        input => ({ method: `server.${service}.${input.action}`, service, action: input.action, ...input }),
        async (request, context) => {
            requirePlatform(server, context);
            const { service, action, ...args } = request;
            return handler(service, action, args, context);
        }
    ));

    serverTool('manage_server_storage', 'storage', 'Read or manage server storage.', { key: string, value: {} }, ['get', 'set', 'delete', 'size', 'clear'], async (_service, action, args) => {
                const storage = server.storage;
                if (!storage || typeof storage[action] !== 'function' || !['get', 'set', 'delete', 'size', 'clear'].includes(action)) throw new Error(`Unsupported storage action: ${action}`);
                return action === 'size' || action === 'clear' ? storage[action]() : storage[action](args.key, args.value);
    });
    serverTool('manage_server_routes', 'routes', 'List, add, or remove registered server routes.', { routePath: string, responseContent: {}, contentType: string }, ['list', 'add', 'remove'], async (_service, action, args) => {
                if (action === 'list') return [...server.routes.keys()];
                if (action === 'remove') {
                    if (args.routePath === mcpPath) throw new Error('The MCP route cannot remove itself.');
                    return { removed: server.routes.delete(args.routePath), routePath: args.routePath };
                }
                if (action === 'add') {
                    if (!args.routePath || server.routes.has(args.routePath)) throw new Error('A new routePath is required and must not already be registered.');
                    server.routes.set(args.routePath, async (_req, res) => {
                        res.writeHead(200, { 'Content-Type': args.contentType || 'text/plain' });
                        res.end(typeof args.responseContent === 'object' ? JSON.stringify(args.responseContent) : args.responseContent ?? 'OK');
                    });
                    return { added: true, routePath: args.routePath };
                }
    });
    serverTool('manage_server_autoscaler', 'autoscaler', 'Inspect and control server autoscaling.', { value: {} }, ['getConfig', 'determineScaleOutTarget', 'scaleOut', 'determineScaleInTarget', 'scaleIn'], async (_service, action, args) => {
                const scaler = server.autoscaler;
                if (!['getConfig', 'determineScaleOutTarget', 'scaleOut', 'determineScaleInTarget', 'scaleIn'].includes(action) || typeof scaler?.[action] !== 'function') throw new Error(`Unsupported autoscaler action: ${action}`);
                return action === 'getConfig' ? scaler.config : scaler[action](args.value);
    });
    serverTool('manage_server_cluster', 'cluster', 'Inspect server cluster state and members, or control a server or worker.', { serverId: string, host: string, status: string, limit: { type: 'integer' }, operation: string, worker: string, value: {}, organizations: {} }, ['self', 'get', 'list', 'control'], async (_service, action, args, context) => {
                if (action === 'self') return { _id: server.id, host: server.host, ip: server.ip, isPrimary: server.isPrimary, isWorker: server.isWorker, workerId: server.workerId, totalWorkers: server.workers?.size, deployment: server.deployment };
                if (action === 'list' || action === 'get') {
                    const query = action === 'get' ? (args.serverId ? { _id: args.serverId } : { host: args.host }) : args.status ? { status: args.status } : {};
                    if (action === 'get' && !args.serverId && !args.host) throw new Error('serverId or host is required.');
                    const response = await sendCrud(server, context, { method: 'object.read', array: 'servers', filter: { query, limit: Math.min(Math.max(Number(args.limit) || (action === 'get' ? 1 : 50), 1), 100) } });
                    return action === 'get' ? response?.object?.[0] : response?.object ?? [];
                }
                if (action === 'control') {
                    if (!args.serverId) throw new Error('serverId is required for cluster control.');
                    const workerOperations = new Set(['cordon', 'shed', 'drain']);
                    const masterOperations = new Set(['reboot', 'shutdown']);
                    const operation = args.operation;
                    if (![...workerOperations, ...masterOperations, 'restart'].includes(operation)) throw new Error(`Unsupported server control operation: ${operation}`);
                    if (workerOperations.has(operation) && args.worker == null) throw new Error(`worker is required for ${operation}.`);
                    if (operation === 'shed' && args.organizations === undefined) throw new Error('organizations is required for shed.');
                    const payload = { method: operation, server: args.serverId, organization_id: context.organization_id };
                    if (args.worker != null) payload.worker = args.worker;
                    if (operation === 'cordon' || operation === 'drain') payload.value = args.value !== false;
                    if (operation === 'shed') payload.organizations = args.organizations;
                    if (masterOperations.has(operation) || (operation === 'restart' && args.worker == null)) payload.master = true;
                    const authorized = await authorize(server, context, payload);
                    await server.send(authorized);
                    return { success: true, action, operation, payload: authorized };
                }
                throw new Error(`Unsupported cluster action: ${action}`);
    });

    return tools;
}
