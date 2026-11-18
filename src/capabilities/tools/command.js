import { exec } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { createWorkspaceResolver } from '../workspace.js';
import { platformAccessError } from '../platform.js';

const DEFAULT_TIMEOUT = 120000;
const MAX_COMMAND_BYTES = 64 * 1024;

function resolveTimeout(value, maximum) {
  const timeout = Math.trunc(Number(value)) || DEFAULT_TIMEOUT;
  return Math.min(maximum, Math.max(1000, timeout));
}

/**
 * Creates the unrestricted platform command tool. Its only application-level
 * boundary is the authenticated platform organization; the spawned process's
 * operating-system account remains the ultimate permission boundary.
 * @private
 * @environment server
 */
export function createCommandTool({
  server,
  enabled,
  timeout = 600000,
  maxOutputBytes = 1024 * 1024
}) {
  const workspaces = createWorkspaceResolver(server);
  const maximumTimeout = Math.max(1000, Math.trunc(Number(timeout)) || 600000);
  const outputLimit = Math.max(1024, Math.trunc(Number(maxOutputBytes)) || 1024 * 1024);

  return {
    name: 'execute_command',

    handler: async ({ command, cwd, timeout: requestedTimeout, input }, context = {}) => {
      const denied = platformAccessError(server, context?.organization_id);
      if (denied) return denied;
      if (!enabled) {
        return { success: false, error: 'Platform command execution is disabled.' };
      }
      if (typeof command !== 'string' || !command.trim()) {
        throw new Error('A non-empty command is required.');
      }
      if (Buffer.byteLength(command, 'utf8') > MAX_COMMAND_BYTES) {
        throw new Error(`Command cannot exceed ${MAX_COMMAND_BYTES} bytes.`);
      }
      if (input !== undefined && typeof input !== 'string') {
        throw new Error('input must be a string when provided.');
      }

      const workspace = await workspaces.ensure(context.organization_id);
      const workingDirectory = cwd
        ? path.resolve(workspace, String(cwd))
        : workspace;
      const stats = await fs.stat(workingDirectory);
      if (!stats.isDirectory()) {
        throw new Error(`Command working directory is not a directory: ${workingDirectory}`);
      }

      const commandTimeout = resolveTimeout(requestedTimeout, maximumTimeout);
      return new Promise((resolve, reject) => {
        const child = exec(command, {
          cwd: workingDirectory,
          env: process.env,
          encoding: 'utf8',
          maxBuffer: outputLimit,
          timeout: commandTimeout,
          windowsHide: true
        }, (error, stdout = '', stderr = '') => {
          if (error && typeof error.code !== 'number') {
            const failure = String(error.message || error).trim();
            resolve({
              success: true,
              action: 'execute',
              ok: false,
              command,
              cwd: workingDirectory,
              exitCode: null,
              signal: error.signal ?? null,
              stdout,
              stderr,
              failure
            });
            return;
          }

          resolve({
            success: true,
            action: 'execute',
            ok: !error,
            command,
            cwd: workingDirectory,
            exitCode: error?.code ?? 0,
            signal: error?.signal ?? null,
            stdout,
            stderr
          });
        });

        child.once('error', reject);
        if (input !== undefined) child.stdin.end(input);
      });
    }
  };
}
