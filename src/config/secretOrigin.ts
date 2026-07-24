/**
 * Global SecretStorage values may only flow to the server they were created
 * for. Unbound values from older releases remain compatible with global user
 * settings, but are withheld from workspace/folder URL overrides.
 */
export function isSecretOriginAllowed(
  storedOrigin: string | undefined,
  currentOrigin: string,
  hasWorkspaceOverride: boolean
): boolean {
  if (storedOrigin) {
    return storedOrigin === currentOrigin;
  }
  return !hasWorkspaceOverride;
}
