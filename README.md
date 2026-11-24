# CoCreate MCP

`@cocreate/mcp` is a Model Context Protocol adapter for CoCreate Server. It translates MCP requests to the initialized CoCreate Agent; it does not own an inference loop, tool registry, or per-operation authorization implementation.

## Agent integration

CoCreate Agent owns tool definitions, context, configured inference, tool execution, authorization, and continuation. Agent loads its global definitions from CoCreate Config and its persisted model or conversation tools through CRUD.

- `tools/list` reads the current definitions from `server.agent.tools.read()`.
- `tools/call` passes the named Agent tool and arguments to `server.agent.execute()`.
- Agent resolves the tool definition, runs its processing cycle, and returns execution results.

MCP does not create or persist Agent conversations or chat messages. CoCreate Server initializes Agent before MCP.

## Installation

```sh
npm install @cocreate/mcp
```

## Initialization

```js
import MCP from '@cocreate/mcp';

server.mcp = MCP.init(server, {
    allowedOrigins: ['https://your-mcp-client.example']
});
```

Options:

| Option | Description |
|---|---|
| `path` | MCP endpoint path. Defaults to `/mcp`. |
| `allowedOrigins` | Browser origins allowed by CORS. |
| `modelId` | Optional model ID used when the authenticated connection does not provide one. |

Call `server.mcp.close()` during shutdown.

## Authentication and authorization

MCP authenticates the connection with a CoCreate OAuth bearer token. Existing API-key clients can also connect with `X-Api-Key`; the API key must be authorized for `mcp.connect`.

The authenticated identity is passed to Agent as trusted request context. Agent authorizes tool operations and filters execution results. MCP does not authorize individual tools or operations. Client arguments cannot replace the authenticated organization, host, user, or credential.

OAuth discovery and token handling are provided by CoCreate Server's OAuth service. MCP exposes `POST /mcp` and protected-resource metadata for the endpoint.

## Protocol

The endpoint uses stateless JSON-RPC over Streamable HTTP and supports protocol versions `2025-03-26`, `2025-06-18`, and `2025-11-25`, including initialization, `tools/list`, `tools/call`, and `ping`. Request bodies are limited to 1 MiB.
