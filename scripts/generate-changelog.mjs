#!/usr/bin/env node
// Builds CHANGELOG.md from the project's GitHub releases.
//
// Reads release objects from the GitHub REST API as newline-delimited JSON
// on stdin and writes CHANGELOG.md with one section per published release,
// newest first. Run it through npm, which fetches the releases with the
// GitHub CLI:
//
//   npm run changelog
//
// The file is generated during the release build so that the packaged
// extension (and its Marketplace page) carries the full history. It is not
// committed; the release notes on GitHub are the source of truth.

import { readFileSync, writeFileSync } from "node:fs";

const REPO_URL = "https://github.com/arbs-io/github-copilot-llm-gateway";

const releases = readFileSync(0, "utf8")
  .split("\n")
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line))
  .filter((release) => !release.draft && !release.prerelease && release.published_at)
  // Newest version first, so a patch released after a later minor version
  // still sits with its own line.
  .sort((a, b) => compareVersions(b.tag_name, a.tag_name) || b.published_at.localeCompare(a.published_at));

function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff) {
      return diff;
    }
  }
  return 0;
}

if (releases.length === 0) {
  console.error("No published releases found on stdin.");
  process.exit(1);
}

// HTML that release notes legitimately use. Any other tag, such as <think> in
// a pull request title, is meant as text, so it's escaped to stop it being
// swallowed when the Markdown is rendered.
const HTML_TAGS = new Set([
  "a", "b", "blockquote", "br", "code", "del", "details", "div", "em", "h1", "h2",
  "h3", "h4", "h5", "h6", "hr", "i", "img", "kbd", "li", "ol", "p", "picture",
  "pre", "s", "source", "span", "strong", "sub", "summary", "sup", "table",
  "tbody", "td", "th", "thead", "tr", "ul", "video",
]);

function escapeTags(line) {
  return line
    .split(/(`[^`]*`)/)
    .map((part, i) =>
      i % 2
        ? part
        : part.replace(/<(\/?)([A-Za-z][\w-]*)(\s[^<>]*|\/)?>/g, (tag, slash, name, rest = "") =>
            HTML_TAGS.has(name.toLowerCase()) ? tag : `&lt;${slash}${name}${rest}&gt;`,
          ),
    )
    .join("");
}

function formatNotes(body) {
  let inFence = false;
  const lines = [];
  for (const line of (body ?? "").replaceAll("\r\n", "\n").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      lines.push(line);
    } else if (inFence) {
      lines.push(line);
    } else if (line.trim() === "" && (lines.length === 0 || lines.at(-1).trim() === "")) {
      // Collapse runs of blank lines.
    } else {
      // Nest the notes' own headings under the release heading.
      lines.push(escapeTags(line.replace(/^(#{1,5}) /, "#$1 ")));
    }
  }
  const notes = lines.join("\n").trim();
  return notes || "No release notes were published for this version.";
}

const sections = releases.map(
  (release) =>
    `## [${release.tag_name}] - ${release.published_at.slice(0, 10)}\n\n${formatNotes(release.body)}\n`,
);
const links = releases.map((release) => `[${release.tag_name}]: ${REPO_URL}/releases/tag/${release.tag_name}`);

const changelog = `# Changelog

All notable changes to this extension are listed here, newest first. Versions
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html). This file is
generated from the [GitHub releases](${REPO_URL}/releases) when a release is
published.

${sections.join("\n")}
${links.join("\n")}
`;

writeFileSync("CHANGELOG.md", changelog);
console.log(`Wrote CHANGELOG.md with ${releases.length} releases.`);
