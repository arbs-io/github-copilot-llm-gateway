/**
 * Helpers for reasoning about JSON Schema tool definitions sent by VS Code.
 *
 * Used to:
 *  - pick a reasonable default value when the model omits a required arg
 *  - fill those defaults into partial tool call arguments so the downstream
 *    tool invocation doesn't crash on missing fields
 */

export type SchemaLogger = (message: string) => void;

const NOOP_LOGGER: SchemaLogger = () => {
  /* no-op */
};

type JsonSchema = Record<string, unknown>;

/**
 * Pick a default value for a JSON Schema type. Prefers `schema.default` when
 * the schema declares one, otherwise falls back to the empty value for the type.
 * Handles union types like `["string", "null"]` by choosing the first non-null
 * variant (or `null` if `"null"` is allowed).
 */
export function getDefaultForType(schema: JsonSchema | null | undefined): unknown {
  if (!schema?.type) {
    return null;
  }

  switch (schema.type) {
    case 'string':
      return schema.default ?? '';
    case 'number':
    case 'integer':
      return schema.default ?? 0;
    case 'boolean':
      return schema.default ?? false;
    case 'array':
      return schema.default ?? [];
    case 'object':
      return schema.default ?? {};
    case 'null':
      return null;
    default:
      if (Array.isArray(schema.type)) {
        if (schema.type.includes('null')) {
          return null;
        }
        for (const t of schema.type) {
          if (t !== 'null') {
            return getDefaultForType({ ...schema, type: t });
          }
        }
      }
      return null;
  }
}

/**
 * Fill in any missing required properties on a tool call argument object
 * using defaults from the tool's input schema. Returns a shallow copy; the
 * original args object is not mutated.
 */
export function fillMissingRequiredProperties(
  args: Record<string, unknown>,
  toolSchema: JsonSchema | null | undefined,
  log: SchemaLogger = NOOP_LOGGER
): Record<string, unknown> {
  if (!toolSchema?.required || !Array.isArray(toolSchema.required)) {
    return args;
  }

  const properties = (toolSchema.properties ?? {}) as Record<string, JsonSchema>;
  const filledArgs = { ...args };
  const filledProperties: string[] = [];

  for (const requiredProp of toolSchema.required as string[]) {
    if (!(requiredProp in filledArgs)) {
      const propSchema = properties[requiredProp];
      const defaultValue = getDefaultForType(propSchema);
      filledArgs[requiredProp] = defaultValue;
      filledProperties.push(`${requiredProp}=${JSON.stringify(defaultValue)}`);
    }
  }

  if (filledProperties.length > 0) {
    log(`  AUTO-FILLED missing required properties: ${filledProperties.join(', ')}`);
  }

  return filledArgs;
}
