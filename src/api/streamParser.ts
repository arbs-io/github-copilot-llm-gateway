/**
 * Incremental parser for OpenAI-style SSE and newline-delimited JSON streams.
 *
 * The parser only frames records. JSON validation and protocol semantics stay
 * in the API client so malformed payloads fail at a single trust boundary.
 */

export interface StreamRecord {
  data: string;
  done: boolean;
}

interface ServerSentEvent {
  dataLines: string[];
}

const DONE_SENTINEL = '[DONE]';

export interface StreamParserLimits {
  maxBufferCharacters: number;
  maxLineCharacters: number;
  maxEventCharacters: number;
  maxEventDataLines: number;
  maxRecordCharacters: number;
  maxRecordsPerPush: number;
  maxTotalRecords: number;
  maxTotalCharacters: number;
}

export const DEFAULT_STREAM_PARSER_LIMITS: StreamParserLimits = {
  maxBufferCharacters: 1_048_576,
  maxLineCharacters: 1_048_576,
  maxEventCharacters: 4_194_304,
  maxEventDataLines: 65_536,
  maxRecordCharacters: 4_194_304,
  maxRecordsPerPush: 4_096,
  maxTotalRecords: 1_000_000,
  maxTotalCharacters: 67_108_864,
};

export type StreamLimitKind =
  | 'buffer'
  | 'line'
  | 'event'
  | 'record'
  | 'records'
  | 'total';

export class StreamLimitError extends Error {
  public readonly code = 'STREAM_LIMIT_EXCEEDED';

  constructor(
    public readonly kind: StreamLimitKind,
    public readonly limit: number
  ) {
    super(`The inference server stream exceeded the ${kind} limit of ${limit} characters.`);
    this.name = 'StreamLimitError';
  }
}

export class IncrementalStreamParser {
  private buffer = '';
  private currentEvent: ServerSentEvent = { dataLines: [] };
  private currentEventCharacters = 0;
  private totalCharacters = 0;
  private totalRecords = 0;
  private readonly limits: StreamParserLimits;

  constructor(limits: Partial<StreamParserLimits> = {}) {
    this.limits = {
      ...DEFAULT_STREAM_PARSER_LIMITS,
      ...limits,
    };
  }

  public push(chunk: string): StreamRecord[] {
    this.totalCharacters += chunk.length;
    this.assertWithin('total', this.totalCharacters, this.limits.maxTotalCharacters);
    this.buffer += chunk;
    const records: StreamRecord[] = [];

    while (true) {
      const lineEnding = findLineEnding(this.buffer);
      if (!lineEnding) {
        break;
      }

      const line = this.buffer.slice(0, lineEnding.index);
      this.buffer = this.buffer.slice(lineEnding.index + lineEnding.length);
      this.processLine(line, records);
    }

    this.assertWithin('buffer', this.buffer.length, this.limits.maxBufferCharacters);
    return records;
  }

  public flush(): StreamRecord[] {
    const records: StreamRecord[] = [];
    if (this.buffer.length > 0) {
      this.assertWithin('buffer', this.buffer.length, this.limits.maxBufferCharacters);
      this.processLine(this.buffer, records);
      this.buffer = '';
    }
    this.flushEvent(records);
    return records;
  }

  private processLine(line: string, records: StreamRecord[]): void {
    this.assertWithin('line', line.length, this.limits.maxLineCharacters);
    if (line.length === 0) {
      this.flushEvent(records);
      return;
    }

    if (line.startsWith(':')) {
      return;
    }

    const trimmed = line.trim();
    if (trimmed === DONE_SENTINEL || looksLikeJsonRecord(trimmed)) {
      this.flushEvent(records);
      this.pushRecord(trimmed, records);
      return;
    }

    const separator = line.indexOf(':');
    if (separator < 0) {
      this.flushEvent(records);
      this.pushRecord(trimmed, records);
      return;
    }

    const field = line.slice(0, separator);
    let value = line.slice(separator + 1);
    if (value.startsWith(' ')) {
      value = value.slice(1);
    }

    if (field === 'data') {
      this.assertWithin(
        'event',
        this.currentEvent.dataLines.length + 1,
        this.limits.maxEventDataLines
      );
      this.currentEventCharacters += value.length +
        (this.currentEvent.dataLines.length > 0 ? 1 : 0);
      this.assertWithin(
        'event',
        this.currentEventCharacters,
        this.limits.maxEventCharacters
      );
      this.currentEvent.dataLines.push(value);
    }
    // event/id/retry and unknown SSE fields do not affect completion framing.
  }

  private flushEvent(records: StreamRecord[]): void {
    if (this.currentEvent.dataLines.length === 0) {
      return;
    }

    this.pushRecord(this.currentEvent.dataLines.join('\n'), records);
    this.currentEvent = { dataLines: [] };
    this.currentEventCharacters = 0;
  }

  private pushRecord(data: string, records: StreamRecord[]): void {
    this.assertWithin('record', data.length, this.limits.maxRecordCharacters);
    this.assertWithin('records', records.length + 1, this.limits.maxRecordsPerPush);
    this.totalRecords++;
    this.assertWithin('records', this.totalRecords, this.limits.maxTotalRecords);
    records.push(toRecord(data));
  }

  private assertWithin(kind: StreamLimitKind, value: number, limit: number): void {
    if (!Number.isSafeInteger(limit) || limit <= 0 || value > limit) {
      throw new StreamLimitError(kind, limit);
    }
  }
}

function toRecord(data: string): StreamRecord {
  const trimmed = data.trim();
  return {
    data: trimmed,
    done: trimmed === DONE_SENTINEL,
  };
}

function looksLikeJsonRecord(value: string): boolean {
  return value.startsWith('{') || value.startsWith('[');
}

function findLineEnding(value: string): { index: number; length: number } | undefined {
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (character === '\n') {
      return { index, length: 1 };
    }
    if (character !== '\r') {
      continue;
    }
    if (index === value.length - 1) {
      return undefined;
    }
    return {
      index,
      length: value[index + 1] === '\n' ? 2 : 1,
    };
  }
  return undefined;
}
