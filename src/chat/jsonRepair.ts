/**
 * Lenient JSON repair for partial/malformed LLM tool call arguments.
 *
 * Handles the common failure modes seen from streaming tool calls:
 *  - truncated output (unclosed strings, braces, brackets)
 *  - trailing commas
 *  - empty / whitespace-only argument strings
 *  - invalid escape sequences inside string literals (e.g. unescaped
 *    Windows path separators such as `"c:\Users\..."` — issue #70)
 *
 * The repair logic is implemented as a single string-aware scan so that
 * structural characters inside string literals (e.g. `"{"`) are not mistaken
 * for real braces, and so that nested closures happen in the correct order
 * (`{[{` → close with `}]}`, not `]}}`).
 */

export type RepairLogger = (message: string) => void;

const TRAILING_COMMA_PATTERN = /,\s*([}\]])/g;
const NOOP_LOGGER: RepairLogger = () => {
  /* no-op */
};

/**
 * Count literal occurrences of a single character in a string.
 * Does NOT understand string literals — use `balanceStructures` for anything
 * that needs to respect JSON quoting rules. Exported for tests.
 */
export function countChar(str: string, char: string): number {
  let count = 0;
  for (const c of str) {
    if (c === char) {
      count++;
    }
  }
  return count;
}

/**
 * Advance string-literal state by one character.
 * Returns the updated [inString, escaped] pair.
 */
function advanceStringState(c: string, escaped: boolean): [boolean, boolean] {
  if (escaped) {
    return [true, false];
  }
  if (c === '\\') {
    return [true, true];
  }
  if (c === '"') {
    return [false, false];
  }
  return [true, false];
}

const VALID_ESCAPE_CHARS = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't']);
const HEX_DIGIT_PATTERN = /^[0-9a-fA-F]{4}$/;

/**
 * Consume the escape sequence starting at the `\` at `str[i]` inside a string
 * literal. Returns the (possibly repaired) text to emit and how many input
 * characters it covers. Invalid (or truncated) escapes get their backslash
 * doubled so the character after it survives as a literal.
 */
function repairEscapeSequence(str: string, i: number): { text: string; length: number } {
  const next = str[i + 1];
  if (next !== undefined && VALID_ESCAPE_CHARS.has(next)) {
    return { text: str[i] + next, length: 2 };
  }
  if (next === 'u' && HEX_DIGIT_PATTERN.test(str.substring(i + 2, i + 6))) {
    return { text: str.substring(i, i + 6), length: 6 };
  }
  return { text: '\\\\', length: 1 };
}

/**
 * Escape invalid `\` escape sequences inside JSON string literals.
 *
 * Small local models frequently emit tool call arguments containing literal
 * Windows paths without escaping the backslashes — e.g.
 * `{"filePath": "c:\Users\sasha\src\App.tsx"}`. `\U` is not a valid JSON
 * escape, so `JSON.parse` rejects the whole argument object and the tool is
 * invoked with schema-default (empty) arguments, which then fails (issue #70).
 *
 * The scan only rewrites backslashes *inside* string literals whose next
 * character is not a valid escape (`" \ / b f n r t`) and not a `u` followed
 * by four hex digits. A lone trailing backslash at end-of-input (truncated
 * stream) is also escaped so the string can be closed by `balanceStructures`.
 * Valid escape sequences are preserved untouched, so already-correct JSON
 * round-trips unchanged.
 */
export function repairInvalidEscapes(str: string): string {
  let result = '';
  let inString = false;

  for (let i = 0; i < str.length; i++) {
    const c = str[i];

    if (!inString) {
      if (c === '"') {
        inString = true;
      }
      result += c;
      continue;
    }

    if (c === '\\') {
      const { text, length } = repairEscapeSequence(str, i);
      result += text;
      i += length - 1;
      continue;
    }

    if (c === '"') {
      inString = false;
    }
    result += c;
  }

  return result;
}

/**
 * Scan a candidate JSON string, tracking string state and the stack of
 * open `{`/`[` tokens. Appends whatever closers (and an optional closing
 * quote) are needed so the result is structurally balanced.
 *
 * The function never removes characters — if the input already has more
 * closers than openers it's returned unchanged. Characters inside string
 * literals (including escaped quotes via `\"`) are ignored for bracket
 * bookkeeping.
 */
export function balanceStructures(str: string): string {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (const c of str) {
    if (inString) {
      [inString, escaped] = advanceStringState(c, escaped);
      continue;
    }

    switch (c) {
      case '"':
        inString = true;
        break;
      case '{':
      case '[':
        stack.push(c);
        break;
      case '}':
        if (stack[stack.length - 1] === '{') {
          stack.pop();
        }
        break;
      case ']':
        if (stack[stack.length - 1] === '[') {
          stack.pop();
        }
        break;
      default:
        break;
    }
  }

  let result = str;
  if (inString) {
    result += '"';
  }
  while (stack.length > 0) {
    result += stack.pop() === '{' ? '}' : ']';
  }
  return result;
}

/**
 * Back-compat alias — older call sites (and tests) use `balanceBrackets`.
 * The new name is `balanceStructures` because the function also closes
 * unclosed string literals, not just brackets.
 */
export const balanceBrackets = balanceStructures;

/**
 * Try to parse a JSON argument string, applying repair heuristics if the
 * direct parse fails. Returns the parsed value, {} for empty input, or null
 * if repair ultimately fails.
 *
 * The logger (optional) receives diagnostic messages when repair fails so
 * callers can surface them to their own output channel.
 */
export function tryRepairJson(jsonStr: string, log: RepairLogger = NOOP_LOGGER): unknown {
  if (!jsonStr || jsonStr.trim() === '') {
    return {};
  }

  try {
    return JSON.parse(jsonStr);
  } catch {
    // Fall through to repair attempts.
  }

  // Fix invalid escapes first so the string-literal state tracking in
  // balanceStructures sees well-formed escape sequences.
  let repaired = repairInvalidEscapes(jsonStr.trim());
  repaired = repaired.replaceAll(TRAILING_COMMA_PATTERN, '$1');
  repaired = balanceStructures(repaired);

  try {
    return JSON.parse(repaired);
  } catch {
    log(`JSON repair failed. Original: ${jsonStr}`);
    log(`Repaired attempt: ${repaired}`);
    return null;
  }
}
