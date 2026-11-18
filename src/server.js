import { createBuiltInTools } from './tools.js';
import { createPortedRegistry } from './capabilities/registry.js';
import { resolveAIConfig } from './capabilities/config.js';

const DEFAULT_PATH = '/mcp';
const MAX_BODY_BYTES = 1024 * 1024;
const PROTOCOL_VERSION = '2025-11-25';
const SUPPORTED_VERSIONS = new Set([
    '2025-03-26',
    '2025-06-18',
    '2025-11-25'
]);
const responseProtocolVersion = req => SUPPORTED_VERSIONS.has(req.headers['mcp-protocol-version'])
    ? req.headers['mcp-protocol-version']
    : PROTOCOL_VERSION;
const RESERVED_TOOL_NAMES = new Set([
    'crud', 'list_apps', 'list_ai_instructions', 'get_ai_instructions',
    'render_crud', 'describe_api_credentials', 'execute_server_api',
    'run_workflow', 'request_server_file', 'read_virtual_file',
    'write_virtual_file', 'list_virtual_files', 'delete_virtual_file',
    'read_local_file', 'edit_local_file', 'write_local_file',
    'read_project_file', 'write_project_file', 'send_server_message',
    'send_socket_message', 'manage_server_storage', 'manage_server_cluster',
    'manage_server_routes', 'manage_server_autoscaler', 'coc', 'git_project',
    'execute_command', 'search_conversation_history', 'read_reference'
]);

function jsonRpcError(id, code, message) {
    return { jsonrpc: '2.0', id, error: { code, message } };
}

function jsonRpcResult(id, result) {
    return { jsonrpc: '2.0', id, result };
}

function authenticationRequired(id, metadata, description = 'A valid OAuth access token is required.') {
    const challenge = `Bearer resource_metadata="${metadata}", scope="mcp", error="invalid_token", error_description="${description}"`;
    return jsonRpcResult(id, {
        content: [{ type: 'text', text: description }],
        _meta: { 'mcp/www_authenticate': [challenge] },
        isError: true
    });
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
        if (size > MAX_BODY_BYTES) {
            throw Object.assign(new Error('Request body exceeds 1 MiB.'), { status: 413 });
        }
        chunks.push(buffer);
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
        throw Object.assign(new Error('Request body must contain valid JSON.'), { status: 400 });
    }
}

async function authenticateApiKey(server, req) {
    const host = new URL(`https://${req.headers.host || ''}`).hostname;
    const configuredHost = server.host
        ? new URL(`https://${server.host}`).hostname
        : null;
    const organization = server.organization_id && configuredHost === host
        ? { _id: server.organization_id }
        : await server.crud.getOrganization({ host });
    if (!organization?._id || organization.error) {
        throw Object.assign(new Error('Organization not found for this host.'), { status: 404 });
    }

    const apiKeyHeader = req.headers['x-api-key'];
    const apikey = apiKeyHeader;
    if (typeof apikey !== 'string' || !apikey.trim()) {
        throw Object.assign(new Error('An OAuth access token or X-Api-Key is required.'), { status: 401 });
    }

    return {
        organization_id: organization._id,
        host,
        apikey,
        client: req.headers['mcp-client-name'] || 'mcp-client'
    };
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function withTrustedContext(payload, context) {
    if (!isPlainObject(payload) || typeof payload.method !== 'string') {
        throw new Error('A CoCreate authorization envelope with a method is required.');
    }
    const {
        organization_id: _organizationId,
        host: _host,
        apikey: _apikey,
        user_id: _userId,
        ...operation
    } = payload;
    return {
        ...operation,
        organization_id: context.organization_id,
        host: context.host,
        apikey: context.apikey,
        ...(context.user_id && { user_id: context.user_id })
    };
}


function normalizeTool(tool) {
    if (!tool || typeof tool.name !== 'string' || !tool.name.trim() ||
        typeof tool.authorize !== 'function' || typeof tool.handler !== 'function') {
        throw new TypeError('Each MCP tool requires a name, authorize function, and handler.');
    }
    return {
        name: tool.name,
        ...(tool.title && { title: tool.title }),
        description: tool.description || tool.name,
        inputSchema: tool.inputSchema || { type: 'object', properties: {} },
        ...(tool.annotations && { annotations: tool.annotations }),
        _meta: { securitySchemes: [{ type: 'oauth2', scopes: ['mcp'] }], ...(tool._meta || {}) },
        authorize: tool.authorize,
        handler: tool.handler
    };
}

function getToolDefinitions(tools) {
    return [...tools.values()]
        .map(({ authorize, handler, ...definition }) => definition)
        .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Attach a stateless MCP Streamable HTTP endpoint to a CoCreate server.
 * Tools receive verified request context; client arguments cannot set tenant identity.
 *
 * @param {object} server - Initialized CoCreate server.
 * @param {object} [options]
 * @param {string} [options.path='/mcp'] - HTTP route to register.
 * @param {Array<object>} [options.tools] - Additional explicitly registered tools.
 * @returns {{ tools: object, close: Function }} MCP integration controls.
 * @public
 * @environment server
 */
export function init(server, options = {}) {
    if (!server?.routes || typeof server.routes.set !== 'function') {
        throw new TypeError('An initialized CoCreate server with a route registry is required.');
    }
    if (!server.crud?.getOrganization || typeof server.authorize?.request !== 'function') {
        throw new TypeError('CoCreate CRUD organization lookup and authorization are required.');
    }

    const path = options.path || DEFAULT_PATH;
    if (server.routes.has(path)) throw new Error(`CoCreate route is already registered: ${path}`);
    let aiConfigError;
    const aiConfigPromise = Promise.resolve(options.aiConfig
        ? options.aiConfig
        : resolveAIConfig(server, options.ai || {})).catch(error => {
        aiConfigError = error;
        return {};
    });
    const allowedOrigins = new Set(options.allowedOrigins || []);
    const tools = new Map();
    const builtins = createBuiltInTools(server).filter(tool => ['run_workflow', 'read_reference'].includes(tool.name));
    for (const builtin of builtins) tools.set(builtin.name, normalizeTool(builtin));
    for (const definition of options.tools || []) {
        const tool = normalizeTool(definition);
        if (tools.has(tool.name) || RESERVED_TOOL_NAMES.has(tool.name)) throw new Error(`Duplicate or reserved MCP tool: ${tool.name}`);
        tools.set(tool.name, tool);
    }

    const toolsForContext = async context => {
        const aiConfig = await aiConfigPromise;
        if (aiConfigError) throw aiConfigError;
        const availableTools = new Map(tools);
        for (const definition of createPortedRegistry(server, aiConfig, context, { mcpPath: path })) {
            if (availableTools.has(definition.name)) continue;
            availableTools.set(definition.name, normalizeTool(definition));
        }
        return availableTools;
    };

    const route = async (req, res) => {
        const origin = req.headers.origin;
        if (origin && !allowedOrigins.has(origin)) {
            return sendJson(res, 403, { error: 'Origin is not allowed.' });
        }
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
            !acceptedTypes.includes('text/event-stream')) {
            return sendJson(res, 406, { error: 'Accept must include application/json and text/event-stream.' }, corsHeaders);
        }

        let message;
        try {
            message = await readJson(req);
        } catch (error) {
            return sendJson(res, error.status || 400, { error: error.message });
        }
        if (!isPlainObject(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
            return sendJson(res, 400, jsonRpcError(message?.id ?? null, -32600, 'Invalid JSON-RPC request.'));
        }
        const notification = !Object.hasOwn(message, 'id');

        let context;
        try {
            const bootstrap = ['initialize', 'notifications/initialized', 'ping', 'tools/list'].includes(message.method);
            if (req.headers.authorization) {
                const resource = new URL(path, `https://${req.headers.host}`).toString();
                context = await server.oauth?.authenticate(req, { resource, scope: 'mcp' });
            }
            if (!context && message.method === 'tools/call' && req.headers['x-api-key']) {
                context = await authenticateApiKey(server, req);
            }
            if (!context && bootstrap && req.headers['x-api-key']) {
                context = await authenticateApiKey(server, req);
            }
            if (!context && bootstrap) {
                const host = new URL(`https://${req.headers.host || ''}`).hostname;
                const configuredHost = server.host ? new URL(`https://${server.host}`).hostname : null;
                const organization = server.organization_id && configuredHost === host
                    ? { _id: server.organization_id }
                    : await server.crud.getOrganization({ host });
                if (!organization?._id || organization.error) throw Object.assign(new Error('Organization not found for this host.'), { status: 404 });
                context = { organization_id: organization._id, host };
            }
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
                        'MCP-Protocol-Version': responseProtocolVersion(req),
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
                    'MCP-Protocol-Version': responseProtocolVersion(req),
                    ...corsHeaders
                });
            }
            return sendJson(res, status,
                notification ? undefined : jsonRpcError(message.id, -32001,
                    status === 403 ? 'MCP access is not authorized.' : error.message), {
                    ...(status === 401 && { 'WWW-Authenticate': `Bearer resource_metadata="${metadata}", scope="mcp"` }),
                    ...corsHeaders
                });
        }

        let responseVersion = responseProtocolVersion(req);
        const respond = body => sendJson(res, 200, body, {
            'MCP-Protocol-Version': responseVersion,
            ...corsHeaders
        });
        try {
            if (message.method === 'initialize') {
                const requested = message.params?.protocolVersion;
                if (!SUPPORTED_VERSIONS.has(requested)) {
                    return respond(jsonRpcError(message.id, -32602, 'Unsupported MCP protocol version.'));
                }
                const version = requested;
                responseVersion = version;
                return respond(jsonRpcResult(message.id, {
                    protocolVersion: version,
                    capabilities: { tools: { listChanged: false } },
                    serverInfo: { name: 'cocreate-mcp', version: '0.1.0' }
                }));
            }
            if (message.method === 'notifications/initialized') {
                return sendJson(res, 202);
            }
            if (message.method === 'ping') return respond(jsonRpcResult(message.id, {}));
            if (message.method === 'tools/list') {
                return respond(jsonRpcResult(message.id, { tools: getToolDefinitions(await toolsForContext(context)) }));
            }
            if (message.method === 'tools/call') {
                const { name, arguments: args = {} } = message.params || {};
                const tool = (await toolsForContext(context)).get(name);
                if (!tool) return respond(jsonRpcError(message.id, -32602, 'Unknown MCP tool.'));
                try {
                    const operation = await tool.authorize(args, context);
                    const authorizedRequest = await server.authorize.request(
                        withTrustedContext(operation, context), context.user_id
                    );
                    const result = await tool.handler(authorizedRequest, context);
                    const content = typeof result === 'string'
                        ? [{ type: 'text', text: result }]
                        : [{ type: 'text', text: JSON.stringify(result ?? null) }];
                    const toolResult = { content, isError: false };
                    if (req.headers['mcp-protocol-version'] !== '2025-03-26') {
                        toolResult.structuredContent = result ?? null;
                    }
                    return respond(jsonRpcResult(message.id, toolResult));
                } catch (error) {
                    return respond(jsonRpcResult(message.id, {
                        content: [{ type: 'text', text: error.message || 'Tool execution failed.' }],
                        isError: true
                    }));
                }
            }
            if (notification) return sendJson(res, 202);
            return respond(jsonRpcError(message.id, -32601, 'Method not found.'));
        } catch (error) {
            if (!res.headersSent) return respond(jsonRpcError(message.id ?? null, -32603, 'MCP request failed.'));
            res.end();
        }
    };

    if (server.routes.has(path)) {
        throw new Error(`CoCreate route is already registered: ${path}`);
    }
    server.routes.set(path, route);
    return {
        tools: {
            register(definition) {
                const tool = normalizeTool(definition);
                if (tools.has(tool.name) || RESERVED_TOOL_NAMES.has(tool.name)) throw new Error(`Duplicate or reserved MCP tool: ${tool.name}`);
                tools.set(tool.name, tool);
                return () => tools.delete(tool.name);
            },
            async list() {
                return getToolDefinitions(await toolsForContext({ organization_id: server.organization_id, host: server.host }));
            }
        },
        close() {
            if (server.routes.get(path) === route) server.routes.delete(path);
            tools.clear();
        }
    };
}

export default { init };
