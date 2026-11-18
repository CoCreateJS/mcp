import fs from 'node:fs/promises';
import path from 'node:path';

import { createWorkspaceResolver } from '../workspace.js';
import { platformAccessError } from '../platform.js';

const normalizeVirtualPath = (value = '/') =>
  value.startsWith('/') ? value : `/${value}`;

const inferMimeType = (pathname) => ({
  '.css': 'text/css',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain'
})[path.extname(pathname).toLowerCase()] ?? 'text/plain';

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function getContent(file) {
  const content = file.src ?? file.source ?? file.content ?? '';
  if (Buffer.isBuffer(content)) return content;
  if (content?.type === 'Buffer' && Array.isArray(content.data)) {
    return Buffer.from(content.data);
  }
  if (content && typeof content === 'object' && Array.isArray(content.data)) {
    return Buffer.from(content.data);
  }
  return typeof content === 'string' ? content : JSON.stringify(content, null, 2);
}

/**
 * Exposes the CoCreate download/upload workflow without a shell or child
 * process. Only the platform organization may access the local workspace.
 * @private
 * @environment server
 */
export function createCocTool({
  server,
  allowLocalFileSystem,
  allowUnconfirmedLocalWrite
}) {
  const workspaces = createWorkspaceResolver(server);
  const crud = server.crud;

  async function downloadTarget(target, context, overwrite) {
    const pathname = normalizeVirtualPath(target);
    const isPrefix = pathname === '/' || pathname.endsWith('/');
    const query = isPrefix
      ? { pathname: { $regex: `^${escapeRegex(pathname)}` } }
      : {
          $or: [
            { pathname },
            { pathname: target },
            { path: pathname },
            { path: target }
          ]
        };
    let index = 0;
    let downloaded = 0;
    let skipped = 0;

    while (true) {
      const response = await crud.send({
        method: 'object.read',
        array: 'files',
        organization_id: context.organization_id,
        host: context.host,
        filter: {
          query,
          sort: [
            { key: 'pathname', direction: 'asc' },
            { key: '_id', direction: 'asc' }
          ],
          index,
          limit: 1
        }
      });
      const file = response?.object?.[0];
      if (!file) break;
      index++;

      const filePath = file.pathname ?? file.path;
      if (!filePath) continue;
      const relativePath = filePath.replace(/^\/+/, '');
      const fullPath = await workspaces.resolvePath(
        context.organization_id,
        relativePath,
        { forWrite: true }
      );
      const isDirectory = file['content-type'] === 'text/directory' ||
        file.type === 'directory' || filePath.endsWith('/');
      if (isDirectory) {
        await fs.mkdir(fullPath, { recursive: true });
        continue;
      }

      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      try {
        await fs.writeFile(fullPath, getContent(file), overwrite ? undefined : { flag: 'wx' });
        downloaded++;
      } catch (error) {
        if (!overwrite && error.code === 'EEXIST') {
          skipped++;
          continue;
        }
        throw error;
      }
    }

    return { downloaded, skipped };
  }

  return {
    name: 'coc',

    handler: async ({ action, paths = [], site = false, overwrite = false }, context = {}) => {
      const denied = platformAccessError(server, context?.organization_id);
      if (denied) return denied;
      if (!allowLocalFileSystem) {
        return { success: false, error: 'Local file system access is disabled.' };
      }

      const workspace = await workspaces.ensure(context.organization_id);
      const targets = (Array.isArray(paths) ? paths : [paths]).filter(Boolean).map(String);

      if (action === 'download') {
        if (site) targets.unshift('/');
        if (!targets.length) throw new Error('paths is required unless site=true.');

        let downloaded = 0;
        let skipped = 0;
        for (const target of [...new Set(targets)]) {
          const result = await downloadTarget(
            target,
            context,
            overwrite === true
          );
          downloaded += result.downloaded;
          skipped += result.skipped;
        }
        return {
          success: true,
          action,
          workspace,
          downloaded,
          skipped,
          overwrite: overwrite === true
        };
      }

      if (action === 'upload') {
        if (!allowUnconfirmedLocalWrite && context.confirmLocalWrite !== true) {
          return {
            success: false,
            error: 'Live upload requires explicit confirmation. Set context.confirmLocalWrite=true.'
          };
        }
        if (!targets.length) throw new Error('paths is required for upload.');

        const uploaded = [];
        for (const target of targets) {
          const fullPath = await workspaces.resolvePath(context.organization_id, target);
          const stats = await fs.stat(fullPath);
          if (!stats.isFile()) throw new Error(`Upload target must be a file: ${target}`);
          const pathname = normalizeVirtualPath(target);
          const content = await fs.readFile(fullPath, 'utf8');
          const existing = await crud.send({
            method: 'object.read',
            array: 'files',
            organization_id: context.organization_id,
            host: context.host,
            filter: { query: { pathname }, limit: 1 }
          });
          const record = existing?.object?.[0];
          const object = {
            ...(record?._id && { _id: record._id }),
            pathname,
            path: path.posix.dirname(pathname),
            directory: path.posix.basename(path.posix.dirname(pathname)),
            name: path.posix.basename(pathname),
            src: content,
            'content-type': record?.['content-type'] ?? inferMimeType(pathname),
            public: record?.public ?? 'true'
          };
          await crud.send({
            method: record?._id ? 'object.update' : 'object.create',
            array: 'files',
            organization_id: context.organization_id,
            host: context.host,
            object: [object]
          });
          uploaded.push(pathname);
        }
        return { success: true, action, workspace, uploaded };
      }

      throw new Error(`Unsupported coc action: ${action}`);
    }
  };
}
