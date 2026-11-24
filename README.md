# CoCreate MCP

`@cocreate/mcp` is a Model Context Protocol adapter for CoCreate Server. It translates MCP requests to the initialized CoCreate Agent; it does not own an inference loop, tool registry, or per-operation authorization implementation.

## Agent integration

CoCreate Agent owns tool definitions, context, configured inference, tool execution, authorization, and continuation. Global Agent tool and context configuration is seeded through CoCreate Config; Agent also loads its persisted model or conversation tools through CRUD.

- `tools/list` reads the current definitions from `server.agent.tools.read()`.
- `tools/call` passes the authenticated request through the `mcp` workflow, then sends Agent's canonical `agent.calls` payload to `server.agent.execute()`.
- Agent resolves and authorizes the tool, runs the operation without starting another inference turn, and returns execution results. MCP maps the matching result to the MCP tool response.

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
| `provider` | Optional provider label recorded by the normalization workflow; defaults to `mcp`. |

Call `server.mcp.close()` during shutdown.

## Authentication and authorization

MCP authenticates the connection with a CoCreate OAuth bearer token. Existing API-key clients can also connect with `X-Api-Key`; the API key must be authorized for `mcp.connect`.

The authenticated identity is passed to Agent as trusted request context. Agent authorizes tool operations and filters execution results. MCP does not authorize individual tools or operations. Client arguments cannot replace the authenticated organization, host, user, or credential.

MCP clients share the standard `tools/call` envelope. The adapter invokes the CoCreate `mcp` workflow using the workflow service's internal execution method, which returns the normalized payload without sending a socket response. The workflow accepts MCP calls and common OpenAI, Gemini, and Claude tool-call envelopes, and maps them to Agent's `agent.calls` format. It does not assume the provider sends model or inference context.

OAuth discovery and token handling are provided by CoCreate Server's OAuth service. MCP exposes `POST /mcp` and protected-resource metadata for the endpoint.

## Protocol

The endpoint uses stateless JSON-RPC over Streamable HTTP and supports protocol versions `2025-03-26`, `2025-06-18`, and `2025-11-25`, including initialization, `tools/list`, `tools/call`, and `ping`. Request bodies are limited to 1 MiB.
