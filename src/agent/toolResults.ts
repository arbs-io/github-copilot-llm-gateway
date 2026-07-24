const MINIMUM_RESULT_CHARACTERS = 128;

export interface TruncatedToolResult {
  content: string;
  wasTruncated: boolean;
  originalLength: number;
  omittedCharacters: number;
}

/**
 * Bound a tool result while retaining both its initial context and terminal
 * status/error lines. The returned content never exceeds the normalized cap.
 */
export function truncateToolResultContent(
  content: string,
  maxCharacters: number
): TruncatedToolResult {
  const cap = normalizeCap(maxCharacters);
  if (content.length <= cap) {
    return { content, wasTruncated: false, originalLength: content.length, omittedCharacters: 0 };
  }

  let omitted = content.length - cap;
  let notice = buildNotice(omitted);
  let retained = Math.max(0, cap - notice.length);
  let tail = Math.min(retained, Math.max(24, Math.floor(retained / 4)));
  let head = retained - tail;

  omitted = content.length - head - tail;
  notice = buildNotice(omitted);
  retained = Math.max(0, cap - notice.length);
  tail = Math.min(retained, Math.max(24, Math.floor(retained / 4)));
  head = retained - tail;
  omitted = content.length - head - tail;

  return {
    content: `${content.slice(0, head)}${buildNotice(omitted)}${tail > 0 ? content.slice(-tail) : ''}`,
    wasTruncated: true,
    originalLength: content.length,
    omittedCharacters: omitted,
  };
}

function normalizeCap(value: number): number {
  if (!Number.isFinite(value) || value <= 0) { return MINIMUM_RESULT_CHARACTERS; }
  return Math.max(MINIMUM_RESULT_CHARACTERS, Math.floor(value));
}

function buildNotice(omittedCharacters: number): string {
  return `\n\n[LLM Gateway omitted ${omittedCharacters} characters from this tool result.]\n\n`;
}
