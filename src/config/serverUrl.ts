export type ServerUrlValidation =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly error: string };

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charAt(end - 1) === '/') {
    end--;
  }
  return value.slice(0, end);
}

/**
 * Validate and canonicalize the inference-server origin before it can receive
 * prompts or credentials. Paths are preserved for compatible reverse proxies;
 * credentials, query strings, fragments, and non-HTTP protocols are rejected.
 */
export function validateServerUrl(rawValue: string): ServerUrlValidation {
  const value = rawValue.trim();
  if (value.length === 0) {
    return { ok: false, error: 'Please enter an HTTP or HTTPS server URL.' };
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, error: 'Please enter a valid HTTP or HTTPS server URL.' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'Only HTTP and HTTPS server URLs are supported.' };
  }
  if (parsed.username || parsed.password) {
    return {
      ok: false,
      error: 'Do not embed credentials in the server URL. Use the API key or custom headers.',
    };
  }
  if (parsed.search || parsed.hash) {
    return { ok: false, error: 'The server URL must not contain a query string or fragment.' };
  }

  const normalized = stripTrailingSlashes(parsed.toString());
  return { ok: true, value: normalized };
}
