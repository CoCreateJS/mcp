const platformTools = new Set([
  'read_local_file', 'edit_local_file', 'write_local_file',
  'git_project', 'coc', 'execute_command', 'request_server_file',
  'manage_server_storage', 'manage_server_routes',
  'manage_server_autoscaler', 'manage_server_cluster', 'send_server_message'
]);

/** Match trusted request scope against the running server's organization. */
export function isPlatformOrganization(server, organization_id) {
  return typeof organization_id === 'string' && organization_id.trim().length > 0 &&
    typeof server?.organization_id === 'string' && organization_id === server.organization_id;
}

export function platformAccessError(server, organization_id) {
  if (isPlatformOrganization(server, organization_id)) return;
  return {
    success: false,
    error: 'Unauthorized: local filesystem, Git, CLI, and server control access is restricted to the platform organization.'
  };
}

export function isToolAvailable(server, organization_id, name) {
  return !platformTools.has(name) || isPlatformOrganization(server, organization_id);
}

/** Tenant project tools default to CRUD; an explicit local target is denied. */
export function projectStorageTarget(server, organization_id, requested, fallback) {
  return requested ?? (isPlatformOrganization(server, organization_id) ? fallback : 'virtual');
}

/** Only registered custom tools may run; native SDK capabilities stay disabled. */
export function createPermissionHandler(server, organization_id, tools) {
  const registered = new Set(tools.map(tool => tool.name));
  return async permission => {
    if (typeof organization_id === 'string' && organization_id.trim() &&
        permission?.managedApprovalRequired !== true && permission?.kind === 'custom-tool' &&
        registered.has(permission.toolName) && isToolAvailable(server, organization_id, permission.toolName)) {
      return { kind: 'approve-once' };
    }
    return { kind: 'reject', feedback: 'Only the configured, authorized CoCreate tools may run in this session.' };
  };
}
