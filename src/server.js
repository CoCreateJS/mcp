import { randomUUID } from 'node:crypto';

const DEFAULT_PATH = '/mcp';
const MAX_BODY_BYTES = 1024 * 1024;
const PROTOCOL_VERSION = '2025-11-25';
const SUPPORTED_VERSIONS = new Set([
    '2025-03-26',
    '2025-06-18',
    '2025-11-25'
]);

function jsonRpcError(id, code, message) {
    return { jsonrpc: '2.0', id, error: { code, message } };
}

function jsonRpcResult(id, result) {
    return { jsonrpc: '2.0', id, result };
}

function sendJson(res, status, body, headers = {}) {
    if (res.writableEnded) return;
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        ...headers
    });
    res.end(body === undefined ? undefined : JSON.stringify(body));
}

async function readJson(req) {
    const chunks = [];
    let size = 0;

    for await (const chunk of req) {
        const buffer = Buffer.from(chunk);
        size += buffer.length;

        if (size > MAX_BODY_BYTES)
            throw Object.assign(new Error('Request body exceeds 1 MiB.'), { status: 413 });

        chunks.push(buffer);
    }

    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
        throw Object.assign(new Error('Request body must contain valid JSON.'), { status: 400 });
    }
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function authenticateApiKey(server, req) {
    const host = new URL(`https://${req.headers.host || ''}`).hostname;
    const configuredHost = server.host
        ? new URL(`https://${server.host}`).hostname
        : null;
    const organization = server.organization_id && configuredHost === host
        ? { _id: server.organization_id }
        : await server.crud.getOrganization({ host });

    if (!organization?._id || organization.error)
        throw Object.assign(new Error('Organization not found for this host.'), { status: 404 });

    const apikey = req.headers['x-api-key'];
    if (typeof apikey !== 'string' || !apikey.trim())
        throw Object.assign(new Error('An OAuth access token or X-Api-Key is required.'), { status: 401 });

    return {
        organization_id: organization._id,
        host,
        apikey,
        client: req.headers['mcp-client-name'] || 'mcp-client'
    };
}

function trustedAgentRequest(context, modelId) {
    return {
        organization_id: context.organization_id,
        host: context.host,
        ...(context.user_id && { user_id: context.user_id }),
        ...(context.apikey && { apikey: context.apikey }),
        ...((context.model_id || modelId) && {
            model_id: context.model_id || modelId
        })
    };
}

function mcpTool(definition) {
    if (!definition || typeof definition.name !== 'string' ||
        typeof definition.path !== 'string' || typeof definition.method !== 'string')
        throw new TypeError('Agent tools require a name, path, and method.');

    return {
        name: definition.name,
        description: definition.description || definition.name,
        inputSchema: definition.parameters || { type: 'object', properties: {} },
        _meta: {
            securitySchemes: [{ type: 'oauth2', scopes: ['mcp'] }]
        }
    };
}

function toolValue(result) {
    if (result?.error?.length)
        return { error: result.error };
    return result?.data ?? null;
}

function authenticationRequired(id, metadata, description = 'A valid OAuth access token is required.') {
    const challenge = `Bearer resource_metadata="${metadata}", scope="mcp", error="invalid_token", error_description="${description}"`;
    return jsonRpcResult(id, {
        content: [{ type: 'text', text: description }],
        _meta: { 'mcp/www_authenticate': [challenge] },
        isError: true
    });
}

/** Attach the MCP protocol adapter to an initialized CoCreate server. */
export function init(server, options = {}) {
    if (!server?.routes || typeof server.routes.set !== 'function')
        throw new TypeError('An initialized CoCreate server with a route registry is required.');
    if (typeof server.agent?.execute !== 'function' ||
        typeof server.agent?.tools?.read !== 'function')
        throw new TypeError('CoCreate Agent must be initialized before MCP.');

    const path = options.path || DEFAULT_PATH;
    if (server.routes.has(path))
        throw new Error(`CoCreate route is already registered: ${path}`);

    const allowedOrigins = new Set(options.allowedOrigins || []);

    async function toolsForContext(context) {
        const request = trustedAgentRequest(context, options.modelId);
        const response = await server.agent.tools.read(request);
        return response.data || [];
    }

    const route = async (req, res) => {
        const origin = req.headers.origin;
        if (origin && !allowedOrigins.has(origin))
            return sendJson(res, 403, { error: 'Origin is not allowed.' });

        const corsHeaders = origin ? {
            'Access-Control-Allow-Origin': origin,
            'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Api-Key, MCP-Protocol-Version',
            'Access-Control-Max-Age': '600',
            Vary: 'Origin'
        } : {};

        if (req.method === 'OPTIONS') {
            res.writeHead(204, { Allow: 'POST, GET, OPTIONS', ...corsHeaders });
            return res.end();
        }
        if (req.method === 'GET') {
            res.writeHead(405, { Allow: 'POST, OPTIONS', ...corsHeaders });
            return res.end();
        }
        if (req.method !== 'POST') {
            res.writeHead(405, { Allow: 'POST, GET, OPTIONS', ...corsHeaders });
            return res.end();
        }

        const acceptedTypes = (req.headers.accept || '').split(',').map(value => value.trim());
        if (!acceptedTypes.includes('application/json') ||
            !acceptedTypes.includes('text/event-stream'))
            return sendJson(res, 406, { error: 'Accept must include application/json and text/event-stream.' }, corsHeaders);

        let message;
        try {
            message = await readJson(req);
        } catch (error) {
            return sendJson(res, error.status || 400, { error: error.message });
        }

        if (!isPlainObject(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string')
            return sendJson(res, 400, jsonRpcError(message?.id ?? null, -32600, 'Invalid JSON-RPC request.'));

        const notification = !Object.hasOwn(message, 'id');
        let context;

        try {
            const bootstrap = ['initialize', 'notifications/initialized', 'ping'].includes(message.method);

            if (req.headers.authorization) {
                const resource = new URL(path, `https://${req.headers.host}`).toString();
                context = await server.oauth?.authenticate(req, { resource, scope: 'mcp' });
            }

            if (!context && req.headers['x-api-key'])
                context = await authenticateApiKey(server, req);

            if (context?.apikey) {
                await server.authorize.request({
                    method: 'mcp.connect',
                    organization_id: context.organization_id,
                    host: context.host,
                    apikey: context.apikey
                });
            } else if (!context && !bootstrap) {
                const metadata = new URL(`/.well-known/oauth-protected-resource${path}`, `https://${req.headers.host}`).toString();
                if (message.method === 'tools/call') {
                    if (notification) return sendJson(res, 202);
                    return sendJson(res, 200, authenticationRequired(message.id, metadata), {
                        'MCP-Protocol-Version': req.headers['mcp-protocol-version'] || PROTOCOL_VERSION,
                        ...corsHeaders
                    });
                }
                return sendJson(res, 401, notification ? undefined : jsonRpcError(message.id, -32001, 'A valid OAuth access token or API key is required.'), {
                    'WWW-Authenticate': `Bearer resource_metadata="${metadata}", scope="mcp"`,
                    ...corsHeaders
                });
            }
        } catch (error) {
            const status = error.status || (error.code === 'AUTHORIZATION_DENIED' ? 403 : 401);
            const metadata = new URL(`/.well-known/oauth-protected-resource${path}`, `https://${req.headers.host}`).toString();
            if (status === 401 && message.method === 'tools/call') {
                if (notification) return sendJson(res, 202);
                return sendJson(res, 200, authenticationRequired(message.id, metadata), {
                    'MCP-Protocol-Version': req.headers['mcp-protocol-version'] || PROTOCOL_VERSION,
                    ...corsHeaders
                });
            }
            return sendJson(res, status,
                notification ? undefined : jsonRpcError(message.id, -32001,
                    status === 403 ? 'MCP connection is not authorized.' : error.message), {
                    ...(status === 401 && { 'WWW-Authenticate': `Bearer resource_metadata="${metadata}", scope="mcp"` }),
                    ...corsHeaders
                });
        }

        let responseVersion = SUPPORTED_VERSIONS.has(req.headers['mcp-protocol-version'])
            ? req.headers['mcp-protocol-version']
            : PROTOCOL_VERSION;
        const respond = body => sendJson(res, 200, body, {
            'MCP-Protocol-Version': responseVersion,
            ...corsHeaders
        });

        try {
            if (message.method === 'initialize') {
                const requested = message.params?.protocolVersion;
                if (!SUPPORTED_VERSIONS.has(requested))
                    return respond(jsonRpcError(message.id, -32602, 'Unsupported MCP protocol version.'));

                responseVersion = requested;
                return respond(jsonRpcResult(message.id, {
                    protocolVersion: requested,
                    capabilities: { tools: { listChanged: false } },
                    serverInfo: { name: 'cocreate-mcp', version: options.version || '1.0.0' }
                }));
            }
            if (message.method === 'notifications/initialized')
                return sendJson(res, 202);
            if (message.method === 'ping')
                return respond(jsonRpcResult(message.id, {}));

            if (!context) {
                const metadata = new URL(`/.well-known/oauth-protected-resource${path}`, `https://${req.headers.host}`).toString();
                if (message.method === 'tools/call') {
                    if (notification) return sendJson(res, 202);
                    return sendJson(res, 200, authenticationRequired(message.id, metadata), {
                        'MCP-Protocol-Version': responseVersion,
                        ...corsHeaders
                    });
                }
                return sendJson(res, 401, notification ? undefined : jsonRpcError(message.id, -32001, 'A valid OAuth access token or API key is required.'), {
                    'WWW-Authenticate': `Bearer resource_metadata="${metadata}", scope="mcp"`,
                    ...corsHeaders
                });
            }

            if (message.method === 'tools/list') {
                const definitions = await toolsForContext(context);
                return respond(jsonRpcResult(message.id, {
                    tools: definitions.map(mcpTool).sort((a, b) => a.name.localeCompare(b.name))
                }));
            }

            if (message.method === 'tools/call') {
                const { name, arguments: args = {} } = message.params || {};
                if (typeof name !== 'string' || !isPlainObject(args))
                    return respond(jsonRpcError(message.id, -32602, 'A tool name and object arguments are required.'));

                try {
                    const definitions = await toolsForContext(context);
                    const definition = definitions.find(tool => tool.name === name);
                    if (!definition)
                        return respond(jsonRpcError(message.id, -32602, 'Unknown Agent tool.'));

                    const callId = `mcp-${message.id ?? randomUUID()}`;
                    const result = await server.agent.execute({
                        ...trustedAgentRequest(context, options.modelId),
                        agent: {
                            calls: [{
                                id: callId,
                                name,
                                arguments: args
                            }]
                        }
                    });
                    const operation = result.agent?.executionResults?.find(item => item.callId === callId);
                    const value = operation
                        ? toolValue(operation)
                        : result.error?.length
                            ? { error: result.error }
                            : null;
                    const isError = Boolean(operation?.error?.length || result.agentStatus === 'error' || result.error?.length);
                    const toolResult = {
                        content: [{
                            type: 'text',
                            text: typeof value === 'string' ? value : JSON.stringify(value)
                        }],
                        isError
                    };
                    if (responseVersion !== '2025-03-26')
                        toolResult.structuredContent = value;

                    return respond(jsonRpcResult(message.id, toolResult));
                } catch (error) {
                    return respond(jsonRpcResult(message.id, {
                        content: [{ type: 'text', text: error.message || 'Agent execution failed.' }],
                        isError: true
                    }));
                }
            }

            if (notification) return sendJson(res, 202);
            return respond(jsonRpcError(message.id, -32601, 'Method not found.'));
        } catch (error) {
            if (!res.headersSent)
                return respond(jsonRpcError(message.id ?? null, -32603, error.message || 'MCP request failed.'));
            res.end();
        }
    };

    server.routes.set(path, route);

    return {
        tools: {
            list: async context => (await toolsForContext(context || {
                organization_id: server.organization_id,
                host: server.host
            })).map(mcpTool).sort((a, b) => a.name.localeCompare(b.name))
        },
        close() {
            if (server.routes.get(path) === route)
                server.routes.delete(path);
        }
    };
}

export default { init };
