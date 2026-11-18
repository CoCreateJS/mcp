import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { isPlatformOrganization } from './platform.js';

/** Return only a checkout prepared by the running cluster. */
export function getRepositoryWorkspace(server) {
  const checkout = server?.repository?.repositories?.find(entry =>
    entry?.enabled !== false && entry?.checkout?.workspace)?.checkout.workspace;
  if (typeof checkout === 'string' && path.isAbsolute(checkout)) return path.resolve(checkout);
  const inherited = process.env.SERVER_REPOSITORY_ROOT;
  if (isPlatformOrganization(server, process.env.SERVER_REPOSITORY_ORGANIZATION_ID) &&
      typeof inherited === 'string' && path.isAbsolute(inherited)) return path.resolve(inherited);
}

export function createWorkspaceResolver(server) {
  const assertContained = (workspace, target, filePath) => {
    if (target !== workspace && !target.startsWith(`${workspace}${path.sep}`)) {
      throw new Error(`Local file path escapes the prepared repository workspace: ${filePath}`);
    }
  };

  const organizationRoot = (organization_id) => {
    if (!isPlatformOrganization(server, organization_id)) {
      throw new Error('Local workspace access is restricted to the platform organization.');
    }
    const root = getRepositoryWorkspace(server);
    if (!root) throw new Error('No prepared cluster repository is available for local workspace access.');
    return root;
  };

  const resolve = (organization_id, filePath = '.') => {
    const workspace = organizationRoot(organization_id);
    if (typeof filePath !== 'string' || path.isAbsolute(filePath)) {
      throw new Error(`Local file path must be relative to the prepared repository workspace: ${filePath}`);
    }
    const [firstSegment] = filePath.replaceAll('\\', '/').split('/').filter(Boolean);
    if (['.ai', '.git'].includes(firstSegment)) {
      throw new Error(`The ${firstSegment} directory is reserved and cannot be accessed by project file tools.`);
    }
    const target = path.resolve(workspace, filePath);
    assertContained(workspace, target, filePath);
    return target;
  };

  const ensure = async (organization_id) => {
    const workspace = organizationRoot(organization_id);
    if (!(await fs.stat(workspace)).isDirectory()) throw new Error('The prepared cluster checkout must be an existing directory.');
    // Cluster owns checkout creation. AI never invents an organization/sites root.
    return workspace;
  };

  const resolvePath = async (organization_id, filePath = '.', { forWrite = false } = {}) => {
    const workspace = await ensure(organization_id);
    const target = resolve(organization_id, filePath);
    const realWorkspace = await fs.realpath(workspace);

    if (!forWrite) {
      const realTarget = await fs.realpath(target);
      assertContained(realWorkspace, realTarget, filePath);
      return realTarget;
    }

    let existingPath = target;
    while (existingPath !== workspace) {
      try {
        await fs.lstat(existingPath);
        break;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        existingPath = path.dirname(existingPath);
      }
    }

    const realExistingPath = await fs.realpath(existingPath);
    assertContained(realWorkspace, realExistingPath, filePath);

    try {
      const realTarget = await fs.realpath(target);
      assertContained(realWorkspace, realTarget, filePath);
      return realTarget;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return target;
    }
  };

  return { organizationRoot, resolve, resolvePath, ensure };
}

/** SDK state is internal; it never grants a tenant local file or command tools. */
export async function createRuntimeDirectories(server, organization_id, { useRepository = false } = {}) {
  if (typeof organization_id !== 'string' || !organization_id.trim()) {
    throw new Error('An authenticated organization_id is required for an AI runtime.');
  }
  if (useRepository) {
    const workingDirectory = await createWorkspaceResolver(server).ensure(organization_id);
    const baseDirectory = path.join(path.dirname(workingDirectory), '.cocreate', 'ai', path.basename(workingDirectory));
    await fs.mkdir(baseDirectory, { recursive: true, mode: 0o700 });
    return { workingDirectory, baseDirectory, cleanup: async () => {} };
  }
  const root = await fs.mkdtemp(path.join(tmpdir(), 'cocreate-ai-'));
  const workingDirectory = path.join(root, 'work');
  const baseDirectory = path.join(root, 'state');
  const cleanup = () => fs.rm(root, { recursive: true, force: true });
  try {
    await fs.mkdir(workingDirectory, { mode: 0o700 });
    await fs.mkdir(baseDirectory, { mode: 0o700 });
    return { workingDirectory, baseDirectory, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
