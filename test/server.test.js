import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import test from 'node:test';
import MCP from '../src/server.js';

function createServer({
    allowedKey = 'user-api-key',
    deniedMethods = [],
    expectedHost = 'tenant.example.test',
    serverHost
} = {}) {
    const calls = { authorized: [], crud: [], organizationLookups: [] };
    const oauthRecords = [];
    const server = {
        routes: new Map(),
        host: serverHost,
        organization_id: serverHost === expectedHost ? 'server-organization' : undefined,
        crud: {
            async getOrganization({ host }) {
                calls.organizationLookups.push(host);
                assert.equal(host, expectedHost);
                return { _id: 'tenant-organization' };
            },
            async send(payload) {
                calls.crud.push(payload);
                if (payload.array === 'apps') return { object: [] };
                if (payload.array === 'mcp-oauth') {
                    if (payload.method === 'object.read') {
                        const query = payload.filter?.query || {};
                        return { object: oauthRecords.filter(record =>
                            Object.entries(query).every(([key, value]) => record[key] === value)
                        ).slice(0, payload.filter?.limit || 100) };
                    }
                    if (payload.method === 'object.create') {
                        const records = Array.isArray(payload.object) ? payload.object : [payload.object];
                        oauthRecords.push(...records);
                        return { object: records };
                    }
                    if (payload.method === 'object.delete') {
                        const index = oauthRecords.findIndex(record => record._id === payload.object?._id);
                        if (index !== -1) oauthRecords.splice(index, 1);
                        return { success: true };
                    }
                }
                return { object: [{ _id: 'record-1', name: 'Test' }] };
            }
        },
        authenticate: {
            async decodeToken(token) {
                if (token === 'user-session') return { user_id: 'user-1', expires: Date.now() + 60_000 };
                throw new Error('Not a user session');
            }
        },
        authorize: {
            async request(payload, userId) {
                calls.authorized.push(payload);
                if ((payload.apikey !== allowedKey && userId !== 'user-1') || deniedMethods.includes(payload.method)) {
                    throw Object.assign(new Error('Operation is not authorized.'), {
                        code: 'AUTHORIZATION_DENIED'
                    });
                }
                const authorized = { ...payload };
                delete authorized.apikey;
                return authorized;
            }
        }
    };
    return { server, calls, oauthRecords };
}

async function post(server, message, {
    apiKey = 'user-api-key',
    authorization,
    origin,
    host = 'tenant.example.test',
    protocolVersion = '2025-11-25'
} = {}) {
    const req = Readable.from([JSON.stringify(message)]);
    req.method = 'POST';
    req.headers = {
        host,
        accept: 'application/json, text/event-stream',
        ...(authorization && { authorization }),
        ...(apiKey && { 'x-api-key': apiKey }),
        ...(origin && { origin }),
        ...(protocolVersion && { 'mcp-protocol-version': protocolVersion })
    };
    const result = { headers: {}, status: undefined, body: '' };
    const res = {
        writableEnded: false,
        headersSent: false,
        writeHead(status, headers) {
            result.status = status;
            result.headers = headers;
            this.headersSent = true;
        },
        end(body = '') {
            result.body = body.toString();
            this.writableEnded = true;
        }
    };
    await server.routes.get('/mcp')(req, res);
    result.json = result.body ? JSON.parse(result.body) : undefined;
    return result;
}

async function requestRoute(server, pathname, {
    method = 'GET',
    url = pathname,
    headers = {},
    body = ''
} = {}) {
    const req = Readable.from(body ? [Buffer.from(body)] : []);
    req.method = method;
    req.url = url;
    req.headers = { host: 'tenant.example.test', ...headers };
    const result = { headers: {}, status: undefined, body: '' };
    const res = {
        writableEnded: false,
        headersSent: false,
        writeHead(status, responseHeaders) {
            result.status = status;
            result.headers = responseHeaders;
            this.headersSent = true;
        },
        end(responseBody = '') {
            result.body = responseBody.toString();
            this.writableEnded = true;
        }
    };
    await server.routes.get(pathname)(req, res);
    result.json = result.body && result.headers['Content-Type']?.includes('application/json')
        ? JSON.parse(result.body)
        : undefined;
    return result;
}

test('registers a stateless MCP endpoint and negotiates supported protocol versions', async () => {
    const { server } = createServer();
    const mcp = MCP.init(server);
    const response = await post(server, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', clientInfo: { name: 'test', version: '1' } }
    }, { protocolVersion: undefined });

    assert.equal(response.status, 200);
    assert.equal(response.json.result.protocolVersion, '2025-06-18');
    assert.equal(response.headers['MCP-Protocol-Version'], '2025-06-18');
    assert.equal(response.json.result.capabilities.tools.listChanged, false);
    mcp.close();
    assert.equal(server.routes.has('/mcp'), false);
});

test('allows protocol initialization and tool discovery without an API key', async () => {
    const { server, calls } = createServer();
    const mcp = MCP.init(server);
    const initialized = await post(server, {
        jsonrpc: '2.0', id: 31, method: 'initialize',
        params: { protocolVersion: '2025-11-25', clientInfo: { name: 'public-client', version: '1' } }
    }, { apiKey: null });
    const listed = await post(server, {
        jsonrpc: '2.0', id: 32, method: 'tools/list'
    }, { apiKey: null });

    assert.equal(initialized.status, 200);
    assert.equal(listed.status, 200);
    assert.ok(listed.json.result.tools.length > 0);
    assert.deepEqual(calls.authorized, []);
    mcp.close();
});

test('completes DCR, authorization-code PKCE, and an OAuth-authenticated tool call', async () => {
    const { server, calls, oauthRecords } = createServer();
    const mcp = MCP.init(server, {
        aiConfig: {},
        tools: [{
            name: 'who_am_i',
            authorize: async () => ({ method: 'object.read', array: 'contacts' }),
            handler: async (_request, context) => ({ user_id: context.user_id })
        }]
    });

    const resourceMetadata = await requestRoute(server, '/.well-known/oauth-protected-resource/mcp');
    const serverMetadata = await requestRoute(server, '/.well-known/oauth-authorization-server');
    assert.equal(resourceMetadata.status, 200);
    assert.equal(resourceMetadata.json.resource, 'https://tenant.example.test/mcp');
    assert.deepEqual(resourceMetadata.json.authorization_servers, ['https://tenant.example.test']);
    assert.equal(serverMetadata.status, 200);
    assert.ok(serverMetadata.json.code_challenge_methods_supported.includes('S256'));

    const registration = await requestRoute(server, '/oauth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_name: 'ChatGPT test client', redirect_uris: ['https://client.example.test/callback'] })
    });
    assert.equal(registration.status, 201, `${registration.status}: ${registration.body}`);
    const clientId = registration.json.client_id;

    const verifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~';
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const params = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: 'https://client.example.test/callback',
        state: 'state-value',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        resource: 'https://tenant.example.test/mcp',
        scope: 'mcp'
    });
    const authorization = await requestRoute(server, '/oauth/authorize', {
        url: `/oauth/authorize?${params}`
    });
    assert.equal(authorization.status, 302);
    const consent = new URL(authorization.headers.Location);
    assert.equal(consent.pathname, '/auth/oauth.html');

    const decision = await requestRoute(server, '/oauth/decision', {
        method: 'POST',
        headers: {
            origin: 'https://tenant.example.test',
            cookie: 'token=user-session',
            'content-type': 'application/json'
        },
        body: JSON.stringify({ request: consent.searchParams.get('request'), approved: true })
    });
    assert.equal(decision.status, 200);
    const callback = new URL(decision.json.redirect);
    assert.equal(callback.searchParams.get('state'), 'state-value');
    const code = callback.searchParams.get('code');
    assert.ok(code);

    const token = await requestRoute(server, '/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: clientId,
            redirect_uri: 'https://client.example.test/callback',
            code,
            code_verifier: verifier,
            resource: 'https://tenant.example.test/mcp'
        }).toString()
    });
    assert.equal(token.status, 200);
    assert.equal(token.json.token_type, 'Bearer');
    assert.ok(oauthRecords.some(record => record.type === 'token' && record.user_id === 'user-1'));
    const issuedToken = oauthRecords.find(record => record.type === 'token');
    assert.equal(issuedToken.token_hash, createHash('sha256').update(token.json.access_token).digest('hex'));
    assert.equal(issuedToken.resource, 'https://tenant.example.test/mcp');
    assert.ok(issuedToken.scope.includes('mcp'));
    assert.ok(issuedToken.expires_at > Date.now());

    const toolCall = await post(server, {
        jsonrpc: '2.0', id: 33, method: 'tools/call',
        params: { name: 'who_am_i', arguments: {} }
    }, { apiKey: null, authorization: `Bearer ${token.json.access_token}` });
    assert.equal(toolCall.status, 200);
    assert.deepEqual(toolCall.json.result.structuredContent, { user_id: 'user-1' }, JSON.stringify({ response: toolCall.json, oauthQueries: calls.crud.filter(query => query.array === 'mcp-oauth') }));
    assert.equal(calls.authorized.at(-1).user_id, 'user-1');
    assert.equal(calls.authorized.at(-1).apikey, undefined);
    mcp.close();
});

test('lists the registered CRUD tool without creating server-side session state', async () => {
    const { server } = createServer();
    const mcp = MCP.init(server);
    const response = await post(server, {
        jsonrpc: '2.0', id: 2, method: 'tools/list'
    });

    assert.equal(response.status, 200);
    const listedNames = response.json.result.tools.map(tool => tool.name);
    assert.ok(listedNames.includes('crud'));
    assert.ok(listedNames.includes('list_apps'));
    assert.ok(listedNames.includes('get_ai_instructions'));
    assert.equal(response.headers['MCP-Session-Id'], undefined);
    mcp.close();
});

test('uses the configured server organization for the server host', async () => {
    const { server, calls } = createServer({
        expectedHost: 'server.example.test',
        serverHost: 'server.example.test'
    });
    const mcp = MCP.init(server);
    const response = await post(server, {
        jsonrpc: '2.0', id: 10, method: 'tools/list'
    }, { host: 'server.example.test' });

    assert.equal(response.status, 200);
    assert.equal(calls.organizationLookups.length, 0);
    assert.equal(calls.authorized[0].organization_id, 'server-organization');
    mcp.close();
});

test('passes the caller API key through authorization and overwrites tenant arguments', async () => {
    const { server, calls } = createServer();
    const mcp = MCP.init(server);
    const response = await post(server, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
            name: 'crud',
            arguments: {
                method: 'object.read',
                array: 'tasks',
                organization_id: 'attacker-organization',
                host: 'attacker.example.test'
            }
        }
    });

    assert.equal(response.status, 200);
    assert.equal(response.json.result.isError, false);
    assert.deepEqual(calls.authorized[0], {
        method: 'mcp.connect',
        organization_id: 'tenant-organization',
        host: 'tenant.example.test',
        apikey: 'user-api-key'
    });
    assert.deepEqual(calls.authorized.find(payload => payload.array === 'tasks'), {
        method: 'object.read',
        array: 'tasks',
        organization_id: 'tenant-organization',
        host: 'tenant.example.test',
        apikey: 'user-api-key'
    });
    assert.deepEqual(calls.crud.find(payload => payload.array === 'tasks'), {
        method: 'object.read',
        array: 'tasks',
        organization_id: 'tenant-organization',
        host: 'tenant.example.test'
    });
    mcp.close();
});

test('does not dispatch unauthorized CRUD calls', async () => {
    const { server, calls } = createServer({ deniedMethods: ['object.read'] });
    const mcp = MCP.init(server);
    const response = await post(server, {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'crud', arguments: { method: 'object.read', array: 'tasks' } }
    });

    assert.equal(response.status, 200);
    assert.equal(response.json.result.isError, true);
    assert.match(response.json.result.content[0].text, /not authorized/i);
    assert.deepEqual(calls.authorized.map(payload => payload.method), ['mcp.connect', 'object.read']);
    assert.equal(calls.authorized.filter(payload => payload.array === 'tasks').length, 0);
    assert.equal(calls.crud.filter(payload => payload.array === 'tasks').length, 0);
    mcp.close();
});

test('denies API keys without MCP access before listing tools', async () => {
    const { server, calls } = createServer({ deniedMethods: ['mcp.connect'] });
    const mcp = MCP.init(server);
    const response = await post(server, {
        jsonrpc: '2.0', id: 7, method: 'tools/list'
    });

    assert.equal(response.status, 403);
    assert.match(response.json.error.message, /MCP access/i);
    assert.deepEqual(calls.authorized.map(payload => payload.method), ['mcp.connect']);
    mcp.close();
});

test('authorizes every registered tool operation before invoking its handler', async () => {
    const { server, calls } = createServer();
    let handlerCalled = false;
    const mcp = MCP.init(server, {
        tools: [{
            name: 'publish_message',
            inputSchema: { type: 'object', properties: { message: { type: 'string' } } },
            authorize: async input => ({ method: 'message.publish', object: { message: input.message } }),
            handler: async authorizedRequest => {
                handlerCalled = true;
                return authorizedRequest;
            }
        }]
    });
    const response = await post(server, {
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: { name: 'publish_message', arguments: { message: 'hello' } }
    });

    assert.equal(response.json.result.isError, false);
    assert.equal(handlerCalled, true);
    assert.deepEqual(calls.authorized.map(payload => payload.method), ['mcp.connect', 'message.publish']);
    assert.equal(response.json.result.structuredContent.organization_id, 'tenant-organization');
    mcp.close();
});

test('requires every registered tool to define an authorization envelope', () => {
    const { server } = createServer();
    assert.throws(() => MCP.init(server, {
        tools: [{ name: 'unsafe', handler: async () => 'called' }]
    }), /authorize function/);
});

test('returns an OAuth challenge instead of demanding an API key on tool calls', async () => {
    const { server, calls } = createServer();
    const mcp = MCP.init(server);
    const response = await post(server, {
        jsonrpc: '2.0', id: 9, method: 'tools/call',
        params: { name: 'run_workflow', arguments: { method: 'workflow.example' } }
    }, { apiKey: null });

    assert.equal(response.status, 200);
    assert.equal(response.json.result.isError, true);
    assert.match(response.json.result._meta['mcp/www_authenticate'][0], /resource_metadata=/);
    assert.equal(calls.authorized.length, 0);
    mcp.close();
});

test('blocks secret reads before authorization or CRUD dispatch', async () => {
    const { server, calls } = createServer();
    const mcp = MCP.init(server);
    const response = await post(server, {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'crud', arguments: { method: 'object.read', array: 'secrets' } }
    });

    assert.equal(response.json.result.isError, true);
    assert.match(response.json.result.content[0].text, /secrets array/i);
    assert.deepEqual(calls.authorized.map(payload => payload.method), ['mcp.connect']);
    assert.equal(calls.crud.filter(payload => payload.array === 'secrets').length, 0);
    mcp.close();
});

test('rejects browser origins that are not explicitly allowed', async () => {
    const { server, calls } = createServer();
    const mcp = MCP.init(server);
    const response = await post(server, {
        jsonrpc: '2.0', id: 6, method: 'tools/list'
    }, { origin: 'https://untrusted.example' });

    assert.equal(response.status, 403);
    assert.equal(calls.authorized.length, 0);
    mcp.close();
});

test('serves MCP initialization and tool discovery over a real local HTTP connection', async () => {
    const { server } = createServer({ expectedHost: '127.0.0.1' });
    const mcp = MCP.init(server);
    const httpServer = createHttpServer((req, res) =>
        server.routes.get(new URL(req.url, 'http://localhost').pathname)(req, res));
    await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
    const { port } = httpServer.address();

    try {
        const initialized = await fetch(`http://127.0.0.1:${port}/mcp`, {
            method: 'POST',
            headers: {
                Accept: 'application/json, text/event-stream',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: { protocolVersion: '2025-11-25', clientInfo: { name: 'http-test', version: '1' } }
            })
        });
        const initializeBody = await initialized.text();
        assert.equal(initialized.status, 200, initializeBody);
        assert.equal(JSON.parse(initializeBody).result.serverInfo.name, 'cocreate-mcp');

        const listed = await fetch(`http://127.0.0.1:${port}/mcp`, {
            method: 'POST',
            headers: {
                Accept: 'application/json, text/event-stream',
                'Content-Type': 'application/json',
                'MCP-Protocol-Version': '2025-11-25'
            },
            body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
        });
        assert.equal(listed.status, 200);
        const listedNames = (await listed.json()).result.tools.map(tool => tool.name);
        assert.ok(listedNames.includes('crud'));
        assert.ok(listedNames.includes('list_apps'));
    } finally {
        mcp.close();
        await new Promise(resolve => httpServer.close(resolve));
    }
});
