# CoCreate MCP

`@cocreate/mcp` gives MCP clients such as GitHub Copilot access to a CoCreate
Server instance and its application data. It carries forward the CoCreate
tooling and application-aware behavior currently provided by Server AI, but
the client supplies the model and AI runtime. MCP does not start or call an AI
provider.

Server AI remains a separate package and is not modified by this module. MCP
is being developed as the replacement for its Copilot-facing tool bridge; the
Server AI runtime can later be rewritten around direct API use.

## Application-aware data access

The `crud` tool follows CoCreate's data model rather than treating arrays as
unrelated tables:

- It supports storage, database, array, index, and object CRUD methods.
- It resolves an app name or singular name through the tenant's `apps` records
  and maps that name to the app's physical array.
- It applies the app's configured query filter to reads and updates, and its
  scalar defaults to creates.
- It normalizes query, projection, fields, skip, sort, and limit options into
  the CoCreate CRUD filter contract.
- It rejects credential writes to `secrets` and `apis`, validates endpoint
  and webhook records, and returns object references alongside matching data.

When an app name is unfamiliar or a query does not identify the right data,
`list_apps` can show app names, singular names, physical arrays, filters, and
paths. The client can then use the returned mapping to make a more precise
CRUD request. `render_crud` returns an app and object reference for client-side
details or code views; `read_reference` resolves a reference to a field or
complete object details.

## Instructions and AI context

`list_ai_instructions` discovers the enabled instruction names. Use
`get_ai_instructions` to retrieve the selected instruction, its examples, and
the source files referenced by its `sources` list. Source files are read from
the tenant's CoCreate `files` array and are authorized separately. This lets an
MCP client fetch focused CoCreate guidance when needed instead of relying on a
generic model prompt.

`describe_api_credentials` reports which credential fields a configured AI
provider profile requires and which are missing; it never returns secret
values. Server AI's chat-specific credential form and response lifecycle are
not part of this MCP tool because an MCP client owns its own user interaction.

## Tool registry

MCP includes core application-discovery, instruction, reference, and CRUD
tools. It also ports Server AI's reusable tool factories into
`src/capabilities/`. Their descriptions and JSON input schemas come from the
same `ai.tools` configuration used by Server AI, so configured tools are
listed and exposed through MCP with their configured behavior.

The ported registry covers:

- Configured APIs: `execute_server_api`
- Workflow execution: `run_workflow`
- Application files: `request_server_file`, `read_virtual_file`,
  `write_virtual_file`, `list_virtual_files`, `delete_virtual_file`,
  `read_project_file`, `write_project_file`
- Project workspace: `read_local_file`, `edit_local_file`, `write_local_file`,
  `git_project`, and the constrained `coc` download/upload workflow
- Server and client messaging: `send_server_message`, `send_socket_message`
- Platform controls: `manage_server_cluster`, `manage_server_storage`,
  `manage_server_autoscaler`, and `manage_server_routes`
- Conversation messages: `search_conversation_history`
- Host command execution: `execute_command`, when enabled by configuration

The tool registry keeps the same configuration gate as Server AI: a shared
tool is available when it has an `ai.tools` definition, while the required
CRUD, instruction, app-reference, and `coc` definitions are built in. Tools
that Server AI restricts to the platform organization keep that restriction.
Local file and Git tools require `ai.allowLocalFileSystem`; arbitrary command
execution requires `ai.allowPlatformCommands`. Local writes continue to honor
`ai.allowUnconfirmedLocalWrite` and the tool's confirmation context.

Webhook configuration is managed as CoCreate data through CRUD on `webhooks`.
Execution remains in the configured CoCreate API/webhook pipeline; MCP does
not add an alternate code-execution route for webhook definitions.

## Initialization

`MCP.init()` reads the existing `ai` server configuration and asynchronous
configuration records before serving tool-list and tool-call requests. The
initializer itself remains synchronous. Install MCP and its configuration
dependencies in the CoCreate Server deployment:

```sh
npm install @cocreate/mcp
```

```js
import MCP from '@cocreate/mcp';

server.mcp = MCP.init(server, {
  allowedOrigins: ['https://your-mcp-client.example'],
  ai: {
    // Optional overrides for the existing ai configuration.
    defaultStorageTarget: 'virtual'
  },
  tools: [
    {
      name: 'get_server_status',
      description: 'Read the current server status.',
      inputSchema: { type: 'object', properties: {} },
      authorize: async () => ({
        method: 'object.read',
        array: 'servers',
        filter: { query: { _id: server.id } }
      }),
      handler: async authorizedRequest => server.crud.send(authorizedRequest)
    }
  ]
});
```

Additional MCP-specific tools use the same explicit authorization contract:
their `authorize(input, context)` function builds a CoCreate operation envelope,
and their handler receives the sanitized authorized request and authenticated
context. Any additional CoCreate CRUD operation inside a handler must pass
through `server.authorize.request()` as well.

Call `server.mcp.close()` during shutdown.

## Authentication and authorization

MCP follows the MCP OAuth authorization profile: public protocol discovery,
OAuth 2.1 authorization code with PKCE (S256), then bearer-token authentication
for protected tool calls. Existing CoCreate API-key clients can also use the
explicit `X-Api-Key` header. OAuth discovery is served at
`/.well-known/oauth-protected-resource/mcp` and
`/.well-known/oauth-authorization-server`; dynamic client registration is
available at `/oauth/register`. The authorization flow uses the CoCreate App
sign-in and consent page at `/auth/oauth.html`. The page checks the existing
CoCreate session before showing sign-in, and reuses the existing `signIn`
action when a session is needed. The authorization server stores hashed,
short-lived codes and token records in the tenant's `mcp-oauth` array. Access
tokens expire after 10 minutes and refresh tokens rotate when used. The
authorization metadata advertises dynamic client registration for public
clients using the `none` token endpoint authentication method.

OAuth access tokens are opaque, short-lived, stored as hashes, and bound to the
MCP resource and the CoCreate user who approved the connection. MCP supplies
that verified `user_id` to CoCreate authorization for every tool operation.
No API key is embedded in the OAuth token or copied into MCP configuration.
`initialize` and `tools/list` are public and expose protocol/tool descriptions;
they do not run tools. Protected `tools/call` requests require either the OAuth
bearer token or an explicit `X-Api-Key`. API-key calls still require `mcp.connect`
and per-operation authorization. A missing OAuth token produces the MCP
`mcp/www_authenticate` challenge that tells ChatGPT to start account linking.
Tools advertise OAuth in `_meta.securitySchemes`. Missing or expired credentials
on a tool call return an `isError` result with `_meta["mcp/www_authenticate"]`
and the protected-resource metadata URL so ChatGPT can start or renew OAuth.
MCP overwrites tenant and credential fields from tool arguments with the
authenticated request context. Platform-only tools also verify that the
resolved organization is the CoCreate platform organization.

## CoCreate service boundaries

CoCreate's existing sign-in/session code authenticates the user, and
`server.authorize.request()` evaluates each tool operation. The API module
executes configured outbound APIs/endpoints, the webhook module handles inbound
provider callbacks, the workflow module runs configured workflow records, and
AST evaluates those records. MCP calls these services after authentication;
they do not implement the external OAuth authorization-server protocol. MCP
therefore owns only the OAuth protocol routes and transaction/token records
needed to connect those existing services to ChatGPT.

For OAuth support shared by other integrations, the reusable option is a
dedicated CoCreate OAuth authorization-server module or an external identity
provider. Generic endpoint, webhook, and workflow records do not provide OAuth
discovery, redirects, PKCE, token exchange, or bearer-token validation. The
current MCP-local code is the narrow protocol adapter; its consent page reuses
CoCreate's existing sign-in session.

App resolution, instruction-source reads, app-reference lookups, API
operations, workflow calls, and tool-specific server actions each pass
through the existing authorization service. Listing a tool does not grant
permission to call it. Configure browser origins explicitly in
`allowedOrigins`; server-to-server clients without an `Origin` header do not
need a CORS entry.

## MCP endpoint

The endpoint is `POST /mcp` by default and uses stateless JSON-RPC over
Streamable HTTP. The implementation supports protocol versions
`2025-03-26`, `2025-06-18`, and `2025-11-25`, plus initialization, `tools/list`,
`tools/call`, and `ping`. Request bodies are limited to 1 MiB.

## Development

```sh
npm test
```
