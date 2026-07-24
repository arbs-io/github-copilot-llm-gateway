const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const INVALID_HEADER_VALUE_PATTERN = /[\u0000-\u0008\u000A-\u001F\u007F]/;
const UNSAFE_TRANSPORT_HEADERS = new Set([
  '__proto__',
  'connection',
  'content-length',
  'constructor',
  'host',
  'keep-alive',
  'proxy-connection',
  'prototype',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export const MAX_CUSTOM_HEADERS = 64;
export const MAX_CUSTOM_HEADER_NAME_CHARACTERS = 256;
export const MAX_CUSTOM_HEADER_VALUE_CHARACTERS = 16_384;

export function validateCustomHeader(
  name: string,
  value: string
): string | undefined {
  if (
    name.length === 0 ||
    name.length > MAX_CUSTOM_HEADER_NAME_CHARACTERS ||
    !HEADER_NAME_PATTERN.test(name)
  ) {
    return 'Header name must be a valid HTTP token.';
  }
  if (UNSAFE_TRANSPORT_HEADERS.has(name.toLowerCase())) {
    return 'This transport-controlled header cannot be overridden.';
  }
  if (
    value.length > MAX_CUSTOM_HEADER_VALUE_CHARACTERS ||
    INVALID_HEADER_VALUE_PATTERN.test(value)
  ) {
    return 'Header value contains unsupported control characters or is too long.';
  }
  return undefined;
}

export function filterCustomHeaders(
  headers: Record<string, unknown> | undefined
): Record<string, string> {
  const filtered: Record<string, string> = {};
  if (!headers) { return filtered; }

  const entries = readPlainHeaderEntries(headers);
  if (!entries) { return filtered; }
  for (const [name, value] of entries) {
    if (Object.keys(filtered).length >= MAX_CUSTOM_HEADERS) { break; }
    if (typeof value !== 'string' || validateCustomHeader(name, value)) { continue; }
    filtered[name] = value;
  }
  return filtered;
}

function readPlainHeaderEntries(
  headers: Record<string, unknown>
): Array<[string, unknown]> | undefined {
  try {
    const prototype = Object.getPrototypeOf(headers) as object | null;
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(headers).length > 0
    ) {
      return undefined;
    }
    const entries: Array<[string, unknown]> = [];
    for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(headers))) {
      if (
        descriptor.get ||
        descriptor.set ||
        !('value' in descriptor) ||
        descriptor.enumerable !== true
      ) {
        return undefined;
      }
      entries.push([name, descriptor.value]);
    }
    return entries;
  } catch {
    return undefined;
  }
}
