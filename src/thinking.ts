/**
 * ThinkingParser — streams text through and separates <thinking>/<think> blocks
 * from regular content, handling tag boundaries that split across SSE chunks.
 *
 * Emits items with type:
 *   't' — regular text content
 *   'T' — thinking/reasoning content
 *   'E' — end of a thinking block (vscode_reasoning_done)
 */

export interface ThinkingChunk {
  /** 't' = text, 'T' = thinking, 'E' = end-of-thinking */
  t: 't' | 'T' | 'E';
  c: string;
}

const OPEN_TAGS: [string, string][] = [
  ['<thinking>', '</thinking>'],
  ['<think>', '</think>'],
];

// Close tags that should be stripped if seen outside a thinking block
// (happens when LM Studio routes reasoning_content separately but leaves </think> in content)
const STRAY_CLOSE_TAGS: string[] = ['</thinking>', '</think>'];

export class ThinkingParser {
  private buf = '';
  private inThink = false;
  private closeTag = '';

  /**
   * Feed a new streamed chunk. Returns zero or more ThinkingChunks to report.
   */
  process(chunk: string): ThinkingChunk[] {
    this.buf += chunk;
    const results: ThinkingChunk[] = [];

    while (this.buf.length > 0) {
      if (this.inThink) {
        results.push(...this._processInsideThink());
        if (this.inThink) {
          // Still inside tag and no close tag found — hold partial tail and wait
          break;
        }
      } else {
        const advanced = this._processOutsideThink(results);
        if (!advanced) { break; }
      }
    }

    return results;
  }

  /**
   * Call after the stream ends to flush any remaining buffered content.
   */
  flush(): ThinkingChunk[] {
    const results: ThinkingChunk[] = [];

    if (this.buf.length > 0) {
      results.push({ t: this.inThink ? 'T' : 't', c: this.buf });
      this.buf = '';
    }

    if (this.inThink) {
      results.push({ t: 'E', c: '' });
      this.inThink = false;
      this.closeTag = '';
    }

    return results;
  }

  // ---- private helpers ----

  private _processInsideThink(): ThinkingChunk[] {
    const results: ThinkingChunk[] = [];
    const ci = this.buf.indexOf(this.closeTag);

    if (ci >= 0) {
      // Found the closing tag
      if (ci > 0) {
        results.push({ t: 'T', c: this.buf.slice(0, ci) });
      }
      results.push({ t: 'E', c: '' });
      this.buf = this.buf.slice(ci + this.closeTag.length);
      this.inThink = false;
      this.closeTag = '';
    } else {
      // Closing tag not yet seen — emit safe prefix, hold possible partial tag tail
      const hold = this._partialSuffixLen(this.closeTag);
      const safe = this.buf.length - hold;
      if (safe > 0) {
        results.push({ t: 'T', c: this.buf.slice(0, safe) });
        this.buf = this.buf.slice(safe);
      }
      // If nothing advanced, caller breaks out of the while loop
    }

    return results;
  }

  private _processOutsideThink(results: ThinkingChunk[]): boolean {
    // Find which opening tag appears first
    let best = -1;
    let bOpen = '';
    let bClose = '';

    for (const [ot, ct] of OPEN_TAGS) {
      const i = this.buf.indexOf(ot);
      if (i >= 0 && (best < 0 || i < best)) {
        best = i;
        bOpen = ot;
        bClose = ct;
      }
    }

    // Also check for stray close tags (e.g. LM Studio sends </think> in content
    // when it already routed the thinking body through reasoning_content).
    // If a close tag appears before any open tag, strip it silently.
    for (const ct of STRAY_CLOSE_TAGS) {
      const i = this.buf.indexOf(ct);
      if (i >= 0 && (best < 0 || i < best)) {
        // Emit text before the stray close tag, then discard the tag itself
        if (i > 0) {
          results.push({ t: 't', c: this.buf.slice(0, i) });
        }
        this.buf = this.buf.slice(i + ct.length);
        return true;
      }
    }

    if (best >= 0) {
      // Emit text before the opening tag
      if (best > 0) {
        results.push({ t: 't', c: this.buf.slice(0, best) });
      }
      this.buf = this.buf.slice(best + bOpen.length);
      this.inThink = true;
      this.closeTag = bClose;
      return true;
    }

    // No opening tag found — emit safe prefix (hold partial opening tag tail)
    const hold = this._partialOpenTagSuffixLen();
    const safe = this.buf.length - hold;

    if (safe > 0) {
      results.push({ t: 't', c: this.buf.slice(0, safe) });
      this.buf = this.buf.slice(safe);
      return true;
    }

    return false; // Nothing advanced
  }

  /**
   * How many trailing bytes of `buf` could be the start of `tag`?
   * Used to avoid emitting bytes that might be part of an incoming tag.
   */
  private _partialSuffixLen(tag: string): number {
    for (let i = tag.length - 1; i > 0; i--) {
      if (this.buf.endsWith(tag.slice(0, i))) {
        return i;
      }
    }
    return 0;
  }

  /**
   * How many trailing bytes of `buf` could be the start of ANY opening tag?
   * Only hold based on opening tags — stray close tags are stripped on sight,
   * not anticipated speculatively.
   */
  private _partialOpenTagSuffixLen(): number {
    let hold = 0;
    for (const [ot] of OPEN_TAGS) {
      for (let i = ot.length - 1; i > 0; i--) {
        if (this.buf.endsWith(ot.slice(0, i)) && i > hold) {
          hold = i;
          break;
        }
      }
    }
    return hold;
  }
}
