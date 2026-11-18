import { createApiTool } from './tools/api.js';
import { createAutoscalerTool } from './tools/autoscaler.js';
import { createCocTool } from './tools/coc.js';
import { createCommandTool } from './tools/command.js';
import { createFileTools } from './tools/files.js';
import { createGitTool } from './tools/git.js';
import { createRouteTool } from './tools/routes.js';
import { createSendTool } from './tools/send.js';
import { createServerClusterTool } from './tools/servers.js';
import { createSocketTool } from './tools/socket.js';
import { createStorageTool } from './tools/storage.js';
import { createMcpCrudTool, createAppTools } from './crud.js';
import { projectStorageTarget, isToolAvailable } from './platform.js';
import { getCredentialRequirements, getMissingCredentialKeys } from './credentials.js';

const fallbackSchema = { type: 'object', properties: {}, additionalProperties: true };
const supported = (definition, config = {}) => ({
    name: definition.name,
    description: config.description || definition.description || definition.name,
    inputSchema: config.parameters || definition.inputSchema || fallbackSchema,
    authorize: definition.authorize,
    handler: definition.handler
});

const fixedToolConfigs = {
    crud: {
        description: 'Read or modify CoCreate data, with app-name resolution, app-specific filters/defaults, and object references.',
        parameters: null
    },
    list_apps: {
        description: 'Find application definitions and map an app name to its physical CoCreate array.',
        parameters: { type: 'object', properties: { search: { type: 'string' }, limit: { type: 'integer' } }, additionalProperties: false }
    },
    list_ai_instructions: {
        description: 'List enabled instruction names before fetching a specific instruction.',
        parameters: { type: 'object', properties: { search: { type: 'string' }, limit: { type: 'integer' } }, additionalProperties: false }
    },
    describe_api_credentials: {
        description: 'Show the credential field names required by an API profile without returning any secret values.',
        parameters: { type: 'object', properties: { api: { type: 'string' } }, required: ['api'], additionalProperties: false }
    },
    render_crud: {
        description: 'Return a CoCreate app view reference for a previously authorized record. Does not return a large field value.',
        parameters: {
            type: 'object',
            properties: {
                array: { type: 'string' }, object: { type: 'string' }, key: { type: 'string' },
                language: { type: 'string' }, display: { type: 'string', enum: ['details', 'code', 'form'] },
                storage: { type: 'string' }, database: { type: 'string' }
            },
            required: ['array', 'object', 'key'], additionalProperties: false
        }
    },
    get_ai_instructions: {
        description: 'Retrieve CoCreate operating instructions, examples, and referenced source files by name.',
        parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false }
    },
    coc: {
        description: 'Platform organization only. Download database-backed CoCreate files to the prepared project workspace or upload workspace changes to CoCreate files.',
        parameters: {
            type: 'object', properties: {
                action: { type: 'string', enum: ['download', 'upload'] },
                paths: { type: 'array', items: { type: 'string' } },
                site: { type: 'boolean' }, overwrite: { type: 'boolean' }
            }, required: ['action'], additionalProperties: false
        }
    }
};

function trusted(context, payload) {
    const { organization_id: _org, host: _host, apikey: _key, user_id: _user, ...operation } = payload;
    return {
        ...operation,
        organization_id: context.organization_id,
        host: context.host,
        apikey: context.apikey,
        ...(context.user_id && { user_id: context.user_id })
    };
}

function scopedServer(server, context) {
    const crud = Object.create(server.crud);
    crud.send = async payload => {
        const authorized = await server.authorize.request(trusted(context, payload), context.user_id);
        return server.crud.send(authorized);
    };

    const scoped = Object.create(server);
    scoped.crud = crud;
    if (typeof server.send === 'function') {
        scoped.send = async payload => {
            const authorized = await server.authorize.request(trusted(context, payload), context.user_id);
            return server.send(authorized);
        };
    }
    if (server.api?.send) {
        const api = Object.create(server.api);
        api.send = async payload => {
            const authorized = await server.authorize.request(trusted(context, payload), context.user_id);
            return server.api.send(authorized);
        };
        scoped.api = api;
    }
    return scoped;
}

function makeTemplates(server, aiConfig, context, mcpPath) {
    const scoped = scopedServer(server, context);
    const settings = {
        server: scoped,
        allowLocalFileSystem: aiConfig.allowLocalFileSystem === true,
        allowUnconfirmedLocalWrite: aiConfig.allowUnconfirmedLocalWrite === true
    };
    const fileTools = createFileTools({
        ...settings,
        crud: scoped.crud,
        defaultStorageTarget: aiConfig.defaultStorageTarget || 'virtual'
    });
    const routesTool = createRouteTool({ server: scoped });
    const originalRouteHandler = routesTool.handler;
    routesTool.handler = async (input = {}, routeContext = {}) => {
        if (input.routePath === mcpPath && ['add', 'remove'].includes(input.action)) {
            throw new Error('The MCP endpoint route cannot be changed by a tool call.');
        }
        return originalRouteHandler(input, routeContext);
    };

    return [
        createApiTool({ server: scoped, organization_id: context.organization_id, host: context.host }),
        createSendTool({ server: scoped, organization_id: context.organization_id }),
        ...fileTools.tools,
        createSocketTool({ server: scoped }),
        createStorageTool({ server: scoped }),
        createServerClusterTool({ server: scoped }),
        routesTool,
        createAutoscalerTool({ server: scoped }),
        createCocTool(settings),
        createGitTool(settings),
        ...(aiConfig.allowPlatformCommands === true ? [createCommandTool({
            server: scoped,
            enabled: true,
            timeout: aiConfig.platformCommandTimeout,
            maxOutputBytes: aiConfig.platformCommandMaxOutputBytes
        })] : [])
    ];
}

function methodForTool(name, input) {
    if (name === 'execute_server_api') return input;
    if (name === 'send_socket_message') {
        if (typeof input.data?.method !== 'string') throw new Error('data.method is required.');
        return { ...input.data, clientId: input.clientId, broadcast: input.broadcast };
    }
    if (name === 'send_server_message') {
        if (typeof input.method !== 'string') throw new Error('method is required.');
        return input;
    }
    const action = typeof input.action === 'string' ? input.action : 'execute';
    return { ...input, method: `mcp.${name}.${action}` };
}

function createInstructionTools(server) {
    return [
        {
            name: 'search_conversation_history',
            description: 'Search messages in a specified conversation within the authenticated organization.',
            inputSchema: { type: 'object', properties: { conversation_id: { type: 'string' }, query: { type: 'string' }, limit: { type: 'integer' }, skip: { type: 'integer' } }, required: ['conversation_id'], additionalProperties: false },
            authorize: async (input, context) => {
                const query = { conversation_id: input.conversation_id };
                if (input.query) query.content = { $regex: input.query.slice(0, 200).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
                return { method: 'object.read', array: 'ai-messages', filter: { query, key: { role: 1, content: 1 }, sort: [{ key: '_id', direction: -1 }], index: Math.max(Number(input.skip) || 0, 0), limit: Math.min(Math.max(Number(input.limit) || 12, 1), 20) }, organization_id: context.organization_id, host: context.host, apikey: context.apikey };
            },
            handler: async request => {
                const response = await server.crud.send(request);
                return { messages: (response?.object ?? []).reverse().map(({ role, content }) => ({ role, content })), count: response?.filter?.count };
            }
        },
        {
            name: 'list_ai_instructions',
            description: 'List enabled CoCreate AI instruction names and descriptions. Use get_ai_instructions to fetch the relevant guidance and sources.',
            inputSchema: { type: 'object', properties: { search: { type: 'string' }, limit: { type: 'integer' } }, additionalProperties: false },
            authorize: async (input, context) => ({
                method: 'object.read', array: 'ai-instructions',
                filter: { query: { enabled: true, ...(input.search && { name: { $regex: input.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } }) }, key: { name: 1, description: 1, default: 1 }, limit: Math.min(Math.max(input.limit || 100, 1), 100) },
                organization_id: context.organization_id, host: context.host, apikey: context.apikey
            }),
            handler: async request => {
                const response = await server.crud.send(request);
                return { instructions: (response?.object ?? []).map(({ name, description, default: isDefault }) => ({ name, description, default: isDefault === true })) };
            }
        },
        {
            name: 'get_ai_instructions',
            description: 'Fetch named CoCreate operating instructions, examples, and the content of referenced source files.',
            inputSchema: fixedToolConfigs.get_ai_instructions.parameters,
            authorize: async (input, context) => ({
                method: 'object.read', array: 'ai-instructions',
                filter: { query: { name: input.name, enabled: true }, limit: 1 },
                organization_id: context.organization_id, host: context.host, apikey: context.apikey
            }),
            handler: async (request, context) => {
                const response = await server.crud.send(request);
                const instruction = response?.object?.[0];
                if (!instruction) return { error: `No AI instructions found with name "${request.filter.query.name}".` };
                const sources = [];
                for (const source of instruction.sources ?? []) {
                    const pathname = source.pathname ?? source.path;
                    if (!pathname) { sources.push({ ...source, found: false }); continue; }
                    const fileRequest = await server.authorize.request(trusted(context, {
                        method: 'object.read', array: 'files',
                        filter: { query: { $or: [{ pathname }, { path: pathname }] }, key: { name: 1, pathname: 1, path: 1, src: 1, content: 1, 'content-type': 1, updated: 1 }, limit: 1 }
                    }), context.user_id);
                    const file = (await server.crud.send(fileRequest))?.object?.[0];
                    sources.push(file
                        ? { ...source, name: source.name ?? file.name, pathname: file.pathname ?? file.path ?? pathname, content: file.src ?? file.content ?? '', contentType: file['content-type'], updated: file.updated, found: true }
                        : { ...source, pathname, found: false });
                }
                return { name: instruction.name, description: instruction.description, instructions: instruction.instructions ?? instruction.content ?? '', examples: instruction.examples ?? [], sources };
            }
        }
    ];
}

function createCredentialDescriptionTool(server, aiConfig) {
    if (!aiConfig.providers || typeof aiConfig.providers !== 'object') return;
    return {
        name: 'describe_api_credentials',
        description: 'Describe which credential fields a configured AI provider API profile requires. Never returns credential values.',
        inputSchema: { type: 'object', properties: { api: { type: 'string' } }, required: ['api'], additionalProperties: false },
        authorize: async (input, context) => ({ method: 'object.read', array: 'apis', filter: { query: { name: input.api }, limit: 1 }, organization_id: context.organization_id, host: context.host, apikey: context.apikey }),
        handler: async (request) => {
            const profile = (await server.crud.send(request))?.object?.[0];
            if (!profile?._id) return { error: `No API configuration named "${request.filter.query.name}" was found.` };
            const match = Object.entries(aiConfig.providers).find(([providerId, config]) =>
                providerId === request.filter.query.name || config?.api === request.filter.query.name
            );
            if (!match) return { error: `No AI provider configuration is mapped to API "${request.filter.query.name}".` };
            const [provider, providerConfig] = match;
            const requirements = getCredentialRequirements(providerConfig, provider);
            return {
                api: profile.name,
                provider,
                required: requirements.keys.map(key => ({ key, label: requirements.labels[key] })),
                missing: getMissingCredentialKeys(profile, requirements.keys)
            };
        }
    };
}

function createRenderCrudTool(server) {
    return {
        name: 'render_crud',
        description: fixedToolConfigs.render_crud.description,
        inputSchema: fixedToolConfigs.render_crud.parameters,
        authorize: async (input, context) => ({
            method: 'object.read', array: input.array,
            ...(input.storage !== undefined && { storage: input.storage }),
            ...(input.database !== undefined && { database: input.database }),
            filter: { query: { _id: input.object }, key: { _id: 1 }, limit: 1 },
            mcpView: { key: input.key, language: input.language, display: input.display },
            organization_id: context.organization_id, host: context.host, apikey: context.apikey
        }),
        handler: async (request, context) => {
            const { mcpView, ...crudRequest } = request;
            const record = (await server.crud.send(crudRequest))?.object?.[0];
            if (!record?._id) throw new Error('The requested record could not be found.');
            const appRequest = await server.authorize.request(trusted(context, {
                method: 'object.read', array: 'apps',
                filter: { query: { array: request.array }, key: { _id: 1, path: 1, array: 1 }, limit: 20 }
            }), context.user_id);
            const app = (await server.crud.send(appRequest))?.object?.find(item =>
                (Array.isArray(item.array) ? item.array : [item.array]).includes(request.array));
            return { reference: {
                method: 'object.read', filter: {}, app_id: app?._id, app_path: app?.path,
                ...(request.storage !== undefined && { storage: request.storage }),
                ...(request.database !== undefined && { database: request.database }),
                array: request.array, object: record._id, key: mcpView?.key,
                language: mcpView?.language, display: mcpView?.display || 'details'
            } };
        }
    };
}

export function createPortedRegistry(server, aiConfig, context, { mcpPath = '/mcp' } = {}) {
    const configured = aiConfig.tools || {};
    const definitions = new Map();
    const toolContext = {
        ...context,
        storageTarget: projectStorageTarget(server, context.organization_id, undefined, aiConfig.defaultStorageTarget || 'virtual'),
        confirmLocalWrite: context.confirmLocalWrite === true
    };
    const templates = makeTemplates(server, aiConfig, toolContext, mcpPath);
    const placeholders = [
        ...createInstructionTools(server),
        createRenderCrudTool(server),
        createCredentialDescriptionTool(server, aiConfig),
        ...templates,
        ...createAppTools(server),
        createMcpCrudTool(server)
    ].filter(Boolean);

    for (const placeholder of placeholders) {
        const name = placeholder.name;
        if (configured[name] === false) continue;
        const config = configured[name] ?? fixedToolConfigs[name];
        if (!config) continue;
        if (!isToolAvailable(server, context.organization_id, name)) continue;
        definitions.set(name, supported({
            ...placeholder,
            authorize: placeholder.authorize || ((input) => methodForTool(name, input)),
            handler: placeholder.handler
        }, config));
    }

    // The generic CRUD bridge is always present; its app-aware implementation is
    // installed by the caller so the same trusted authorization boundary applies.
    return [...definitions.values()];
}
