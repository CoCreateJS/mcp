function describeError(error) {
  if (typeof error === 'string') return error;
  if (error?.message) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function getToolErrors(value, path = '', seen = new WeakSet()) {
  if (!value || typeof value !== 'object') return [];
  if (seen.has(value)) return [];
  seen.add(value);

  const errors = [];
  if (Object.hasOwn(value, 'error') && value.error) {
    const entries = Array.isArray(value.error) ? value.error : [value.error];
    for (const error of entries) {
      errors.push({ path: path ? `${path}.error` : 'error', message: describeError(error) });
    }
  }
  if (value.success === false && !value.error) {
    errors.push({ path: path || 'result', message: 'The operation was not successful.' });
  }

  for (const key of ['result', 'response', 'data']) {
    const child = value[key];
    if (child === value) continue;
    if (child && typeof child === 'object') {
      errors.push(...getToolErrors(child, path ? `${path}.${key}` : key, seen));
    }
  }
  return errors;
}

export function assertToolResult(result, toolName) {
  const errors = getToolErrors(result);
  if (!errors.length) return result;

  const details = [...new Set(errors.map(({ message }) => message))].join('; ');
  throw new Error(
    `${toolName} failed: ${details} ` +
    'Treat this as an unsuccessful operation, correct the request or try an appropriate alternative, and do not describe it as an empty successful result.'
  );
}

export function getRecoveryStatus(toolName, error) {
  const message = String(error?.message || error).toLowerCase();
  if (/query|filter|operator|\$in|\$nin|\$all|regex/.test(message)) {
    return 'The request filter failed—correcting it and trying again…';
  }
  if (/not found|does not exist|missing/.test(message)) {
    return 'The requested item was not found—checking its app mapping and alternatives…';
  }
  if (/unauthorized|forbidden|permission|credential/.test(message)) {
    return 'The operation was not authorized—checking the available access path…';
  }
  if (/file|path|directory/.test(message)) {
    return 'The file operation failed—checking the path and available source…';
  }
  return `${toolName.replaceAll('_', ' ')} failed—trying an alternative approach…`;
}
