import { ToolFamily } from './types';

export interface ToolResultDigest {
  family: ToolFamily;
  quality: 'empty' | 'low' | 'useful';
  path?: string;
  command?: string;
  summary: string;
  indicatesVisibleProgress: boolean;
}

export function inferToolFamily(toolName: string): ToolFamily {
  const name = toolName.toLowerCase();
  if (/(^|_)(memory|remember|recall|memo)(_|$)/.test(name)) { return 'memory'; }
  if (/(^|_)(task|complete|finish|done|submit)(_|$)/.test(name)) { return 'completion'; }
  if (/(^|_)(write|edit|patch|create|update|delete|rename|move|replace|insert)(_|$)/.test(name)) {
    return 'editing';
  }
  if (/(^|_)(list|read|search|grep|find|glob|dir|tree|cat|open|errors)(_|$)/.test(name)) {
    return 'discovery';
  }
  if (/(^|_)(run|terminal|exec|bash|shell|command)(_|$)/.test(name)) { return 'execution'; }
  if (/(^|_)(fetch|http|request|download|web)(_|$)/.test(name)) { return 'network'; }
  return 'other';
}

export function inferNextToolFamilies(activeFamily: ToolFamily | undefined): ToolFamily[] {
  switch (activeFamily) {
    case 'memory': return ['discovery', 'editing'];
    case 'discovery': return ['editing', 'completion'];
    case 'editing': return ['execution', 'completion'];
    case 'execution': return ['editing', 'completion'];
    case 'network': return ['discovery', 'completion'];
    case 'completion': return [];
    default: return ['discovery', 'editing'];
  }
}

export function summarizeToolResult(
  toolName: string,
  content: string,
  maxCharacters: number
): ToolResultDigest {
  const family = inferToolFamily(toolName);
  const normalized = normalizeWhitespace(content);
  const clipped = normalized.slice(0, Math.max(32, maxCharacters));
  const quality = classifyQuality(clipped);
  const path = extractPaths(normalized)[0];
  const command = extractCommand(normalized);

  if (family === 'editing') {
    const status = detectEditingStatus(clipped);
    return {
      family,
      quality,
      path,
      summary: buildSummary(toolName, `${status}${path ? ` path=${path}` : ''}${previewSuffix(clipped, 80)}`),
      indicatesVisibleProgress: status !== 'changed' || quality === 'useful',
    };
  }
  if (family === 'execution') {
    const exitCode = extractExitCode(clipped);
    return {
      family,
      quality,
      command,
      summary: buildSummary(
        toolName,
        `${command ? `cmd=${command}` : 'command result'}${exitCode === undefined ? '' : ` exit=${exitCode}`}${tailSuffix(clipped, 100)}`
      ),
      indicatesVisibleProgress: exitCode === 0 || quality === 'useful',
    };
  }
  if (family === 'discovery') {
    const paths = extractPaths(clipped).slice(0, 4);
    return {
      family,
      quality,
      path,
      summary: buildSummary(
        toolName,
        `${paths.length > 0 ? `paths=${paths.join(', ')}` : 'workspace lookup'}${previewSuffix(clipped, 100)}`
      ),
      indicatesVisibleProgress: quality === 'useful',
    };
  }

  const label = family === 'other' ? preview(clipped, 100) : family;
  return {
    family,
    quality,
    summary: buildSummary(toolName, `${label}${previewSuffix(clipped, 80)}`),
    indicatesVisibleProgress: quality === 'useful',
  };
}

function classifyQuality(content: string): ToolResultDigest['quality'] {
  const trimmed = content.trim();
  if (trimmed.length === 0) { return 'empty'; }
  if (trimmed.length < 80 || /^(ok|done|success|created|updated|deleted|renamed|moved)\b/i.test(trimmed)) {
    return 'low';
  }
  return 'useful';
}

function detectEditingStatus(content: string): string {
  if (/\b(created|added|new file)\b/i.test(content)) { return 'created'; }
  if (/\b(updated|edited|patched|modified)\b/i.test(content)) { return 'updated'; }
  if (/\b(deleted|removed)\b/i.test(content)) { return 'deleted'; }
  if (/\b(renamed|moved)\b/i.test(content)) { return 'renamed'; }
  return 'changed';
}

function extractExitCode(content: string): number | undefined {
  const match = /\b(?:exit(?:\s+code)?|code)\s*[:=]?\s*(-?\d+)\b/i.exec(content);
  return match ? Number.parseInt(match[1], 10) : undefined;
}

function extractCommand(content: string): string | undefined {
  const match = /(?:cmd|command)\s*[:=]\s*([^\n]+)/i.exec(content);
  return match ? preview(match[1], 80) : undefined;
}

function extractPaths(content: string): string[] {
  const paths = new Set<string>();
  for (const match of content.matchAll(/\b(?:\/[\w./-]+|[\w.-]+(?:\/[\w.-]+)+(?:\.[\w-]+)?)\b/g)) {
    if (match[0].length >= 3 && !match[0].startsWith('http')) { paths.add(match[0]); }
    if (paths.size >= 8) { break; }
  }
  return [...paths];
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function previewSuffix(content: string, max: number): string {
  const value = preview(content, max);
  return value ? ` preview="${value}"` : '';
}

function tailSuffix(content: string, max: number): string {
  const value = preview(content.slice(-max), max);
  return value ? ` tail="${value}"` : '';
}

function preview(content: string, max: number): string {
  const normalized = normalizeWhitespace(content);
  return normalized.length <= max ? normalized : `${normalized.slice(0, Math.max(0, max - 3))}...`;
}

function buildSummary(toolName: string, detail: string): string {
  return `${toolName}: ${detail}`;
}
