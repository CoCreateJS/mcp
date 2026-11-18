import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { createWorkspaceResolver } from '../workspace.js';
import { platformAccessError } from '../platform.js';

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const SAFE_REVISION = /^[A-Za-z0-9][A-Za-z0-9._/~^{}-]*$/;

const sanitizedEnvironment = () => Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))
);

function boundedLimit(value) {
  const number = Math.trunc(Number(value)) || DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, number));
}

function validateRevision(value = 'HEAD') {
  if (typeof value !== 'string' || !SAFE_REVISION.test(value)) {
    throw new Error(`Invalid Git revision: ${value}`);
  }
  return value;
}

function validateMessage(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('A non-empty commit message is required.');
  }
  if (Buffer.byteLength(value, 'utf8') > 4096) {
    throw new Error('The commit message cannot exceed 4096 bytes.');
  }
  return value.trim();
}

function requireConfirmation(context, allowUnconfirmedLocalWrite, operation) {
  if (!allowUnconfirmedLocalWrite && context.confirmLocalWrite !== true) {
    return {
      success: false,
      error: `${operation} requires explicit confirmation. Set context.confirmLocalWrite=true.`
    };
  }
}

/**
 * Creates a constrained, platform-only Git tool. Repository cloning and
 * credentials intentionally remain server-owned initialization concerns.
 * @private
 * @environment server
 */
export function createGitTool({
  server,
  allowLocalFileSystem,
  allowUnconfirmedLocalWrite,
  gitBinary = 'git'
}) {
  const workspaces = createWorkspaceResolver(server);
  const mutationQueues = new Map();

  const withMutationLock = async (organization_id, operation) => {
    const previous = mutationQueues.get(organization_id) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    mutationQueues.set(organization_id, current);
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (mutationQueues.get(organization_id) === current) {
        mutationQueues.delete(organization_id);
      }
    }
  };

  const validatePaths = (organization_id, values = []) => {
    const paths = (Array.isArray(values) ? values : [values])
      .filter((value) => value !== undefined && value !== null && value !== '')
      .map(String);

    for (const filePath of paths) {
      if (filePath.startsWith(':')) {
        throw new Error(`Git pathspec magic is not allowed: ${filePath}`);
      }
      workspaces.resolve(organization_id, filePath);
    }
    return paths;
  };

  const runGit = async (workspace, args, { allowExitCodes = [] } = {}) => {
    try {
      const { stdout = '', stderr = '' } = await execFileAsync(gitBinary, [
        '-c', 'core.hooksPath=/dev/null',
        '-c', 'core.pager=cat',
        ...args
      ], {
        cwd: workspace,
        encoding: 'utf8',
        maxBuffer: MAX_OUTPUT_BYTES,
        timeout: 30000,
        windowsHide: true,
        env: {
          ...sanitizedEnvironment(),
          GIT_TERMINAL_PROMPT: '0',
          GIT_PAGER: 'cat',
          GIT_EDITOR: 'true',
          GIT_AUTHOR_NAME: 'CoCreate AI',
          GIT_AUTHOR_EMAIL: 'ai@cocreate.local',
          GIT_COMMITTER_NAME: 'CoCreate AI',
          GIT_COMMITTER_EMAIL: 'ai@cocreate.local'
        }
      });
      return { stdout, stderr };
    } catch (error) {
      if (allowExitCodes.includes(error.code)) {
        return { stdout: error.stdout ?? '', stderr: error.stderr ?? '', code: error.code };
      }
      const detail = String(error.stderr || error.stdout || error.message).trim();
      throw new Error(`Git command failed: ${detail}`);
    }
  };

  const assertRepository = async (workspace) => {
    const { stdout } = await runGit(workspace, ['rev-parse', '--is-inside-work-tree']);
    if (stdout.trim() !== 'true') throw new Error('The project workspace is not a Git repository.');
  };

  return {
    name: 'git_project',

    handler: async (payload = {}, context = {}) => {
      const denied = platformAccessError(server, context?.organization_id);
      if (denied) return denied;
      if (!allowLocalFileSystem) {
        return { success: false, error: 'Organization workspace access is disabled.' };
      }

      const workspace = await workspaces.ensure(context.organization_id);
      await assertRepository(workspace);
      const action = payload.action;
      const paths = validatePaths(context.organization_id, payload.paths);

      if (action === 'status') {
        const { stdout } = await runGit(workspace, [
          'status', '--porcelain=v1', '-z', '--untracked-files=all'
        ]);
        return {
          success: true,
          action,
          clean: stdout.length === 0,
          entries: stdout.split('\0').filter(Boolean)
        };
      }

      if (action === 'list_files') {
        const args = ['ls-files', '-z'];
        if (paths.length) args.push('--', ...paths);
        const { stdout } = await runGit(workspace, args);
        const limit = boundedLimit(payload.limit);
        const allFiles = stdout.split('\0').filter(Boolean);
        return {
          success: true,
          action,
          files: allFiles.slice(0, limit),
          count: allFiles.length,
          truncated: allFiles.length > limit
        };
      }

      if (action === 'diff') {
        const args = ['diff', '--no-ext-diff', '--no-color'];
        if (payload.staged === true) args.push('--cached');
        if (payload.stat === true) args.push('--stat');
        if (paths.length) args.push('--', ...paths);
        const { stdout } = await runGit(workspace, args);
        return { success: true, action, staged: payload.staged === true, diff: stdout };
      }

      if (action === 'log') {
        const limit = boundedLimit(payload.limit);
        const { stdout } = await runGit(workspace, [
          'log', `-${limit}`, '--date=iso-strict',
          '--format=%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%s%x1e'
        ]);
        const commits = stdout.split('\x1e').filter((value) => value.trim()).map((value) => {
          const [hash, shortHash, author, email, date, subject] = value.trim().split('\x1f');
          return { hash, shortHash, author, email, date, subject };
        });
        return { success: true, action, commits };
      }

      if (action === 'show') {
        const revision = validateRevision(payload.revision);
        const args = ['show', '--no-ext-diff', '--no-color', '--format=fuller', revision];
        if (paths.length) args.push('--', ...paths);
        const { stdout } = await runGit(workspace, args);
        return { success: true, action, revision, content: stdout };
      }

      if (action === 'commit') {
        const denied = requireConfirmation(context, allowUnconfirmedLocalWrite, 'Git commit');
        if (denied) return denied;
        if (!paths.length) throw new Error('paths is required for a Git commit.');
        const message = validateMessage(payload.message);
        return withMutationLock(context.organization_id, async () => {
          await runGit(workspace, ['add', '--', ...paths]);
          const staged = await runGit(
            workspace,
            ['diff', '--cached', '--quiet', '--', ...paths],
            { allowExitCodes: [1] }
          );
          if (staged.code !== 1) {
            return { success: false, error: 'The selected paths contain no changes to commit.' };
          }
          await runGit(workspace, ['commit', '--only', '--no-verify', '-m', message, '--', ...paths]);
          const { stdout } = await runGit(workspace, ['rev-parse', 'HEAD']);
          return { success: true, action, commit: stdout.trim(), paths };
        });
      }

      if (action === 'create_branch') {
        const denied = requireConfirmation(context, allowUnconfirmedLocalWrite, 'Branch creation');
        if (denied) return denied;
        if (typeof payload.branch !== 'string' || !payload.branch) {
          throw new Error('branch is required.');
        }
        return withMutationLock(context.organization_id, async () => {
          await runGit(workspace, ['check-ref-format', '--branch', payload.branch]);
          await runGit(workspace, ['branch', '--', payload.branch]);
          return { success: true, action, branch: payload.branch };
        });
      }

      if (action === 'switch_branch') {
        const denied = requireConfirmation(context, allowUnconfirmedLocalWrite, 'Branch switching');
        if (denied) return denied;
        if (typeof payload.branch !== 'string' || !payload.branch) {
          throw new Error('branch is required.');
        }
        return withMutationLock(context.organization_id, async () => {
          await runGit(workspace, ['check-ref-format', '--branch', payload.branch]);
          await runGit(workspace, ['switch', '--', payload.branch]);
          return { success: true, action, branch: payload.branch };
        });
      }

      if (action === 'revert') {
        const denied = requireConfirmation(context, allowUnconfirmedLocalWrite, 'Git revert');
        if (denied) return denied;
        const revision = validateRevision(payload.revision);
        return withMutationLock(context.organization_id, async () => {
          const status = await runGit(workspace, [
            'status', '--porcelain=v1', '--untracked-files=no'
          ]);
          if (status.stdout) {
            return {
              success: false,
              error: 'Git revert requires a clean tracked working tree. Commit or discard current changes first.'
            };
          }
          try {
            await runGit(workspace, ['revert', '--no-edit', revision]);
          } catch (error) {
            await runGit(workspace, ['revert', '--abort']).catch(() => {});
            throw error;
          }
          const { stdout } = await runGit(workspace, ['rev-parse', 'HEAD']);
          return { success: true, action, reverted: revision, commit: stdout.trim() };
        });
      }

      throw new Error(`Unsupported Git action: ${action}`);
    }
  };
}
