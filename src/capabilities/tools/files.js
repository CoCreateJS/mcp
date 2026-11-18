import path from 'node:path';
import fs from 'node:fs/promises';
import { createWorkspaceResolver } from '../workspace.js';
import { platformAccessError, projectStorageTarget } from '../platform.js';

/**
 * Factory function creating all file management tools for virtual and local file systems.
 *
 * @param {Object} options
 * @param {Object} options.server - Server context instance
 * @param {Object} options.crud - CoCreate CRUD service
 * @param {string} options.defaultStorageTarget - Default virtual or local target
 * @param {boolean} options.allowLocalFileSystem - Flag indicating whether local disk writes are enabled
 * @returns {Array<Object>} Array of tool definitions for copilot file actions
 * @private
 * @environment server
 */
export function createFileTools({
  server,
  crud,
  defaultStorageTarget,
  allowLocalFileSystem,
  allowUnconfirmedLocalWrite
}) {
  const files = server.files;
  const workspaces = createWorkspaceResolver(server);
  const normalizeVirtualPath = (filePath) =>
    filePath.startsWith('/') ? filePath : `/${filePath}`;
  const inferMimeType = (pathname) => {
    const extension = path.extname(pathname).toLowerCase();
    return {
      '.css': 'text/css',
      '.html': 'text/html',
      '.htm': 'text/html',
      '.js': 'text/javascript',
      '.json': 'application/json',
      '.svg': 'image/svg+xml',
      '.txt': 'text/plain'
    }[extension] ?? 'text/plain';
  };
  const virtualPathQuery = (filePath) => {
    const pathname = normalizeVirtualPath(filePath);
    return {
      $or: [
        { pathname },
        { pathname: filePath },
        { path: pathname },
        { path: filePath }
      ]
    };
  };
  const resolveLocalPath = (filePath, context, options) =>
    workspaces.resolvePath(context?.organization_id, filePath, options);

  const requestServerFileTool = {
    name: 'request_server_file',

    handler: async ({ path: pathname }, context = {}) => {
      const denied = platformAccessError(server, context?.organization_id);
      if (denied) return denied;
      return files.resolveFile({
        pathname,
        hostname: context.host,
        organizationId: context.organization_id,
        crud
      });
    }
  };

  const readVirtualFileTool = {
    name: 'read_virtual_file',

    handler: async ({ filePath }, context) => {
      const result = await crud.send({
        method: 'object.read',
        array: 'files',
        organization_id: context.organization_id,
        filter: {
          query: virtualPathQuery(filePath),
          limit: 1
        }
      });

      const file = result.object[0];
      if (!file) {
        return { error: `Virtual file not found: ${filePath}` };
      }

      return {
        path: file.pathname ?? file.path,
        name: file.name,
        content: file.src ?? file.content ?? '',
        metadata: file.metadata,
        reference: {
          array: 'files',
          object: file._id,
          key: file.src !== undefined ? 'src' : 'content'
        }
      };
    }
  };

  const writeVirtualFileTool = {
    name: 'write_virtual_file',

    handler: async ({ filePath, content, mimeType }, context) => {
      const pathname = normalizeVirtualPath(filePath);
      const fileName = path.basename(pathname);
      const filePathname = path.posix.dirname(pathname);
      const directory = filePathname === '/'
        ? '/'
        : path.posix.basename(filePathname);

      const existing = await crud.send({
        method: 'object.read',
        array: 'files',
        organization_id: context.organization_id,
        filter: {
          query: virtualPathQuery(filePath),
          limit: 1
        }
      });

      const existingFile = existing.object[0];
      let saveResult;

      if (existingFile && existingFile._id) {
        saveResult = await crud.send({
          method: 'object.update',
          array: 'files',
          organization_id: context.organization_id,
          object: [{
            _id: existingFile._id,
            host: ['*'],
            directory,
            path: filePathname,
            pathname,
            name: fileName,
            src: content,
            'content-type': mimeType ?? existingFile['content-type'] ?? inferMimeType(pathname),
            public: 'true'
          }]
        });
      } else {
        saveResult = await crud.send({
          method: 'object.create',
          array: 'files',
          organization_id: context.organization_id,
          object: [{
            host: ['*'],
            directory,
            path: filePathname,
            pathname,
            name: fileName,
            src: content,
            'content-type': mimeType ?? inferMimeType(pathname),
            public: 'true'
          }]
        });
      }

      await server.send({
        method: 'ai.file.updated',
        organization_id: context.organization_id,
        user_id: context.user_id,
        clientId: context.clientId,
        broadcast: false,
        log: false,
        ai: { path: pathname, src: content }
      });

      return {
        success: true,
        path: pathname,
        updated: !!existingFile,
        result: saveResult,
        change: {
          action: existingFile ? 'update' : 'create',
          path: pathname,
          before: existingFile ?? null,
          after: saveResult?.object?.[0] ?? {
            ...(existingFile ?? {}),
            pathname,
            name: fileName,
            src: content,
            'content-type': mimeType ?? existingFile?.['content-type'] ?? inferMimeType(pathname)
          }
        }
      };
    }
  };

  const listVirtualFilesTool = {
    name: 'list_virtual_files',

    handler: async ({ prefix, limit = 200 }, context) => {
      const result = await crud.send({
        method: 'object.read',
        array: 'files',
        organization_id: context.organization_id,
        filter: {
          query: {},
          limit
        }
      });

      const fileObjects = result.object;
      const filtered = prefix
        ? fileObjects.filter((file) =>
            (file.pathname ?? file.path ?? '').startsWith(prefix)
          )
        : fileObjects;

      return {
        count: filtered.length,
        files: filtered.map((f) => ({
          path: f.pathname ?? f.path,
          name: f.name,
          'content-type': f['content-type']
        }))
      };
    }
  };

  const deleteVirtualFileTool = {
    name: 'delete_virtual_file',

    handler: async ({ filePath }, context) => {
      const pathname = normalizeVirtualPath(filePath);
      const existing = await crud.send({
        method: 'object.read',
        array: 'files',
        organization_id: context.organization_id,
        filter: {
          query: virtualPathQuery(filePath),
          limit: 1
        }
      });
      const existingFile = existing.object?.[0] ?? null;
      const result = await crud.send({
        method: 'object.delete',
        array: 'files',
        organization_id: context.organization_id,
        filter: {
          query: virtualPathQuery(filePath)
        }
      });

      await server.send({
        method: 'ai.file.deleted',
        organization_id: context.organization_id,
        user_id: context.user_id,
        clientId: context.clientId,
        broadcast: false,
        log: false,
        ai: { path: pathname }
      });

      return {
        success: true,
        path: pathname,
        result,
        change: {
          action: 'delete',
          path: pathname,
          before: existingFile,
          after: null
        }
      };
    }
  };

  const localFsReadTool = {
    name: 'read_local_file',

    handler: async ({ filePath, startLine = 1, endLine }, context = {}) => {
      const denied = platformAccessError(server, context?.organization_id);
      if (denied) return denied;
      if (!allowLocalFileSystem) {
        return { success: false, error: 'Local file system access is disabled.' };
      }

      const fullPath = await resolveLocalPath(filePath, context);
      const content = await fs.readFile(fullPath, 'utf8');
      const lines = content.split('\n');
      const start = Math.min(lines.length, Math.max(1, Math.trunc(Number(startLine)) || 1));
      const requestedEnd = endLine === undefined
        ? start + 399
        : Math.trunc(Number(endLine));
      const end = Math.min(lines.length, Math.max(start, requestedEnd || start));

      return {
        success: true,
        filePath,
        startLine: start,
        endLine: end,
        totalLines: lines.length,
        hasMore: end < lines.length,
        content: lines.slice(start - 1, end).join('\n')
      };
    }
  };

  const localFsEditTool = {
    name: 'edit_local_file',

    handler: async ({ filePath, oldText, newText }, context = {}) => {
      const denied = platformAccessError(server, context?.organization_id);
      if (denied) return denied;
      if (!allowLocalFileSystem) {
        return { success: false, error: 'Local file system access is disabled.' };
      }
      if (!allowUnconfirmedLocalWrite && context.confirmLocalWrite !== true) {
        return {
          success: false,
          error: 'Local edit requires explicit confirmation. Set context.confirmLocalWrite=true.'
        };
      }
      if (typeof oldText !== 'string' || !oldText) {
        throw new Error('oldText is required and cannot be empty.');
      }
      if (typeof newText !== 'string') throw new Error('newText must be a string.');

      const fullPath = await resolveLocalPath(filePath, context);
      const content = await fs.readFile(fullPath, 'utf8');
      const firstMatch = content.indexOf(oldText);
      if (firstMatch === -1) {
        return { success: false, error: 'oldText was not found; no changes were made.' };
      }
      if (content.indexOf(oldText, firstMatch + oldText.length) !== -1) {
        return {
          success: false,
          error: 'oldText matches more than once; include more surrounding text to make the edit unique.'
        };
      }

      const updated = content.slice(0, firstMatch) + newText +
        content.slice(firstMatch + oldText.length);
      await fs.writeFile(fullPath, updated, 'utf8');
      return {
        success: true,
        filePath,
        replacedCharacters: oldText.length,
        insertedCharacters: newText.length
      };
    }
  };

  const localFsWriteTool = {
    name: 'write_local_file',

    handler: async ({ filePath, content }, context = {}) => {
      const denied = platformAccessError(server, context?.organization_id);
      if (denied) return denied;
      if (!allowLocalFileSystem) {
        return { success: false, error: 'Local file system access is disabled.' };
      }
      if (!allowUnconfirmedLocalWrite && context.confirmLocalWrite !== true) {
        return {
          success: false,
          error: 'Local write requires explicit confirmation. Set context.confirmLocalWrite=true.'
        };
      }

      const fullPath = await resolveLocalPath(filePath, context, { forWrite: true });
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, content, 'utf8');
      return { success: true, filePath };
    }
  };

  const readProjectFileTool = {
    name: 'read_project_file',

    handler: async ({ filePath, target = 'auto', startLine, endLine }, context = {}) => {
      const selected = projectStorageTarget(server, context?.organization_id,
        target === 'auto' ? context?.storageTarget : target, defaultStorageTarget);

      if (target === 'local' && !allowLocalFileSystem) {
        return {
          success: false,
          error: 'Local file system target requested but disabled by configuration.'
        };
      }

      if (selected === 'local') {
        return localFsReadTool.handler({ filePath, startLine, endLine }, context);
      }

      return readVirtualFileTool.handler({ filePath }, context);
    }
  };

  const writeProjectFileTool = {
    name: 'write_project_file',

    handler: async ({ filePath, content, mimeType, target = 'auto' }, context = {}) => {
      const selected = projectStorageTarget(server, context?.organization_id,
        target === 'auto' ? context?.storageTarget : target, defaultStorageTarget);

      if (target === 'local' && !allowLocalFileSystem) {
        return {
          success: false,
          error: 'Local file system target requested but disabled by configuration.'
        };
      }

      if (selected === 'local') {
        return localFsWriteTool.handler({ filePath, content }, context);
      }

      return writeVirtualFileTool.handler({ filePath, content, mimeType }, context);
    }
  };

  const tools = [
    requestServerFileTool,
    readVirtualFileTool,
    writeVirtualFileTool,
    deleteVirtualFileTool,
    listVirtualFilesTool,
    readProjectFileTool,
    writeProjectFileTool
  ];

  if (allowLocalFileSystem) {
    tools.push(localFsReadTool, localFsEditTool, localFsWriteTool);
  }

  return { tools };
}
