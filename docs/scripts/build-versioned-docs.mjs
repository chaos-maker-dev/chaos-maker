#!/usr/bin/env node
/**
 * Generate versioned docs into docs/src/content/docs/ from git tags.
 *
 *   - For every `v*.*.*` tag, extract that tag's docs source into
 *     `<repo>/docs/src/content/docs/<slug>/` (slug = tag with dots → dashes,
 *     e.g. `v0.4.0` → `v0-4-0`).
 *   - The newest stable tag also lands at `docs/src/content/docs/latest/`.
 *     `/latest/` is the public default and tracks released npm versions.
 *     Prereleases never become `/latest/`.
 *   - With `--dev`, the working-tree contents of `docs/content-source/` are
 *     additionally laid down at `docs/src/content/docs/main/` so contributors
 *     can preview unreleased docs locally. CI builds never pass `--dev`, so
 *     `main/` never reaches production.
 *   - Writes a top-level `index.mdx` that redirects `/` → `/latest/`.
 *   - Writes `src/generated/versions.json` with each version's slug, label,
 *     `isLatest` flag, and a manifest of relative page slugs. The route
 *     middleware uses this to scope the sidebar to a single version, and the
 *     VersionSelect component uses the manifests to pick the closest matching
 *     page when the user switches versions.
 *
 * Tag content is sourced from one of:
 *   - `docs/content-source/`     (post-v0.5.0 layout)
 *   - `docs/src/content/docs/`   (pre-v0.5.0 layout)
 * The script auto-picks whichever path the tagged commit actually contains.
 */

import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compareTag, isStable, parseTag } from './semver.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const DOCS_OUT = resolve(__dirname, '../src/content/docs');
const DEV_SOURCE = resolve(__dirname, '../content-source');
const GENERATED_OUT = resolve(__dirname, '../src/generated');
const PAGES_BASE = '/chaos-maker';
const BASE_URL = process.env.BASE_URL || 'https://chaos-maker-dev.github.io';

const HISTORICAL_SOURCE_PATHS = [
  'docs/content-source',
  'docs/src/content/docs',
];

// Top-level docs sections. Any `/chaos-maker/<section>/...` or `/<section>/...`
// link inside an extracted snapshot must be rewritten to live under the
// snapshot's own version slug, otherwise an archived page would jump out of
// its own version namespace into latest.
const KNOWN_SECTIONS = [
  'adapters',
  'api',
  'concepts',
  'getting-started',
  'rationale',
  'recipes',
];

const isDev = process.argv.includes('--dev');

function git(args, opts = {}) {
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  }).trim();
}

function listVersionTags() {
  const out = git(['tag', '-l', 'v*.*.*']);
  if (!out) return [];
  return out
    .split('\n')
    .filter((t) => parseTag(t) !== null);
}

function tagHasPath(tag, path) {
  try {
    const out = git(['ls-tree', '--name-only', tag, '--', path]);
    return out.length > 0;
  } catch {
    return false;
  }
}

function extractTagToDir(tag, destDir) {
  for (const sourcePath of HISTORICAL_SOURCE_PATHS) {
    if (!tagHasPath(tag, sourcePath)) continue;
    const tmp = mkdtempSync(join(tmpdir(), `chaos-docs-${tag}-`));
    try {
      const archive = execFileSync(
        'git',
        ['archive', '--format=tar', tag, '--', sourcePath],
        { cwd: REPO_ROOT, maxBuffer: 256 * 1024 * 1024 },
      );
      execFileSync('tar', ['-xf', '-', '-C', tmp], { input: archive });
      const extracted = join(tmp, sourcePath);
      if (!existsSync(extracted)) {
        throw new Error(`expected ${sourcePath} inside archive for ${tag}`);
      }
      mkdirSync(dirname(destDir), { recursive: true });
      cpSync(extracted, destDir, { recursive: true });
      return true;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  return false;
}

function rewriteVersionLinks(dir, slug) {
  const sectionsAlt = KNOWN_SECTIONS.join('|');
  // Capture the syntactic prefix that introduces a URL  -  markdown link target,
  // jsx href / to attribute, or yaml `link:` value (quoted or bare)  -  so the
  // rewrite only fires on actual link positions and not on prose that happens
  // to mention a path. The `(?:/chaos-maker)?` group makes the rewrite
  // idempotent against both prefixed and base-relative source authors.
  const re = new RegExp(
    `(\\]\\(|href="|href='|to="|to='|link:\\s*"|link:\\s*'|link:\\s+)(/chaos-maker)?/(${sectionsAlt})/`,
    'g',
  );
  const walk = (d) => {
    for (const entry of readdirSync(d)) {
      const p = join(d, entry);
      const st = statSync(p);
      if (st.isDirectory()) { walk(p); continue; }
      if (!entry.endsWith('.mdx') && !entry.endsWith('.md')) continue;
      const text = readFileSync(p, 'utf8');
      const next = text.replace(re, (_m, prefix, _base, section) =>
        `${prefix}${PAGES_BASE}/${slug}/${section}/`,
      );
      if (next !== text) writeFileSync(p, next);
    }
  };
  walk(dir);
}

function injectFrontmatter(dir, lineFn) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      injectFrontmatter(p, lineFn);
      continue;
    }
    if (!entry.endsWith('.mdx') && !entry.endsWith('.md')) continue;
    const text = readFileSync(p, 'utf8');
    const lines = text.split('\n');
    if (lines[0] !== '---') continue;
    let end = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i] === '---') { end = i; break; }
    }
    if (end < 0) continue;
    const inserted = lineFn(p);
    if (!inserted || inserted.length === 0) continue;
    const next = [
      ...lines.slice(0, end),
      ...inserted,
      ...lines.slice(end),
    ];
    writeFileSync(p, next.join('\n'));
  }
}

function injectBanner(dir, bannerContent) {
  injectFrontmatter(dir, () => [
    'banner:',
    `  content: '${bannerContent.replace(/'/g, "\\'")}'`,
  ]);
}

// Starlight builds editLink URLs as `${baseUrl}${page-source-path}`. Pages
// land under `<slug>/...` in the content collection, but the corresponding
// authoring source on `main` lives at `docs/content-source/...` without any
// version segment. Inject an explicit `editUrl` per page so links point at
// the right source  -  or `false` for archived versions, which should not be
// edited through the live site.
function injectEditUrl(dir, slug, mode) {
  injectFrontmatter(dir, (filePath) => {
    if (mode === 'disabled') {
      return ['editUrl: false'];
    }
    const rel = filePath.slice(dir.length + 1).replace(/\\/g, '/');
    return [
      `editUrl: 'https://github.com/chaos-maker-dev/chaos-maker/edit/main/docs/content-source/${rel}'`,
    ];
  });
}

// Walk a version directory after extraction and return the relative slugs
// Starlight will produce. A file at `<dir>/getting-started/install.mdx` maps
// to slug `getting-started/install`; an `index.mdx` collapses to its parent
// directory (or empty string for the version root).
function collectVersionPages(dir) {
  const pages = [];
  const walk = (current) => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      const st = statSync(full);
      if (st.isDirectory()) { walk(full); continue; }
      if (!entry.endsWith('.mdx') && !entry.endsWith('.md')) continue;
      const rel = relative(dir, full).replace(/\\/g, '/');
      const withoutExt = rel.replace(/\.(mdx|md)$/, '');
      const slug = withoutExt === 'index'
        ? ''
        : withoutExt.endsWith('/index')
          ? withoutExt.slice(0, -'/index'.length)
          : withoutExt;
      pages.push(slug);
    }
  };
  walk(dir);
  // Sort for deterministic output (test snapshots, hash-stable sidebars).
  pages.sort();
  return pages;
}

function writeVersionsManifest(entries, latestTag) {
  mkdirSync(GENERATED_OUT, { recursive: true });
  const payload = {
    base: PAGES_BASE,
    latestTag,
    versions: entries,
  };
  writeFileSync(
    join(GENERATED_OUT, 'versions.json'),
    `${JSON.stringify(payload, null, 2)}\n`,
  );
}

function tagToSlug(tag) {
  // Slug encoding maps every `.` to `-`, so prereleases must use only
  // dot-separated alphanumeric identifiers. A hyphen inside an identifier
  // would collide with the separator and break round-tripping. parseTag
  // rejects such tags up front, so this is a defensive check for callers
  // that bypass parseTag.
  const parsed = parseTag(tag);
  if (!parsed) {
    throw new Error(
      `[docs-versions] tag "${tag}" is not a valid version tag; ` +
        'prereleases must be dot-separated alphanumeric identifiers (e.g. v1.0.0-rc.1)',
    );
  }
  return tag.replace(/\./g, '-');
}

function writeRedirectIndex(latestTag) {
  const target = `${PAGES_BASE}/latest/`;
  const body = `---
title: Chaos Maker
description: Frontend chaos engineering toolkit for testing resilience across Playwright, Cypress, WebdriverIO, and Puppeteer.
template: splash
hero:
  tagline: Latest stable release is ${latestTag}.
  actions:
    - text: Open ${latestTag} docs
      link: ${target}
      icon: right-arrow
      variant: primary
head:
  - tag: meta
    attrs:
      http-equiv: refresh
      content: 0; url=${target}
  - tag: link
    attrs:
      rel: canonical
      href: ${target}
---

import { LinkCard } from '@astrojs/starlight/components';

This is the redirect landing for the Chaos Maker docs. Versioned docs are published from git tags and the latest stable release is **${latestTag}**.

<LinkCard title="Open ${latestTag} docs" href="${target}" />
`;
  writeFileSync(join(DOCS_OUT, 'index.mdx'), body);
}

function clean() {
  if (!existsSync(DOCS_OUT)) {
    mkdirSync(DOCS_OUT, { recursive: true });
    return;
  }
  for (const entry of readdirSync(DOCS_OUT)) {
    if (entry === '.gitkeep') continue;
    rmSync(join(DOCS_OUT, entry), { recursive: true, force: true });
  }
}

function generateLlmFiles(latestDest, latestTag) {
  const publicDir = resolve(__dirname, '../public');
  if (!existsSync(publicDir)) {
    mkdirSync(publicDir, { recursive: true });
  }

  const pagesInfo = [];

  const walk = (current) => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith('.mdx') && !entry.endsWith('.md')) continue;

      // Read file content
      const content = readFileSync(full, 'utf8');
      
      // Parse YAML frontmatter
      const lines = content.split('\n');
      let title = '';
      let description = '';
      if (lines[0] === '---') {
        let end = -1;
        for (let i = 1; i < lines.length; i++) {
          if (lines[i] === '---') {
            end = i;
            break;
          }
        }
        if (end > 0) {
          const fmLines = lines.slice(1, end);
          for (const fmL of fmLines) {
            const matchTitle = fmL.match(/^title:\s*(.*)$/);
            if (matchTitle) {
              title = matchTitle[1].replace(/['"]/g, '').trim();
            }
            const matchDesc = fmL.match(/^description:\s*(.*)$/);
            if (matchDesc) {
              description = matchDesc[1].replace(/['"]/g, '').trim();
            }
          }
        }
      }

      // Compute relative URL
      const rel = relative(latestDest, full).replace(/\\/g, '/');
      const withoutExt = rel.replace(/\.(mdx|md)$/, '');
      const pathSegment = withoutExt === 'index'
        ? ''
        : withoutExt.endsWith('/index')
          ? withoutExt.slice(0, -'/index'.length)
          : withoutExt;
      
      const url = `${PAGES_BASE}/latest/${pathSegment ? pathSegment + '/' : ''}`;

      // Clean content for llms-full.txt
      let cleanContent = content;
      // Strip frontmatter
      if (lines[0] === '---') {
        let end = -1;
        for (let i = 1; i < lines.length; i++) {
          if (lines[i] === '---') {
            end = i;
            break;
          }
        }
        if (end > 0) {
          cleanContent = lines.slice(end + 1).join('\n');
        }
      }
      // Strip imports
      cleanContent = cleanContent.split('\n').filter(line => !line.trim().startsWith('import ')).join('\n');
      
      // Strip Starlight tags/JSX structures (CardGrid, Card, LinkCard).
      // Limitation: This regex-based stripping removes the opening, closing, and self-closing tags
      // of CardGrid, Card, and LinkCard, but leaves nested content inside intact.
      cleanContent = cleanContent
        .replace(/<CardGrid[\s\S]*?\/?>|<\/CardGrid\s*>/gi, '')
        .replace(/<Card[\s\S]*?\/?>|<\/Card\s*>/gi, '')
        .replace(/<LinkCard[\s\S]*?\/?>|<\/LinkCard\s*>/gi, '')
        .trim();

      pagesInfo.push({
        title: title || pathSegment || 'Home',
        description,
        url,
        pathSegment,
        content: cleanContent,
      });
    }
  };

  walk(latestDest);

  // Sort pages for deterministic ordering
  pagesInfo.sort((a, b) => a.url.localeCompare(b.url));

  // 1. Generate docs/public/llms.txt
  let llmsTxt = `# Chaos Maker\n\n`;
  llmsTxt += `> Frontend chaos engineering toolkit for testing resilience across Playwright, Cypress, WebdriverIO, and Puppeteer.\n\n`;
  llmsTxt += `This file provides a curated index of the Chaos Maker documentation, designed for consumption by Large Language Models (LLMs) and AI tools.\n\n`;
  llmsTxt += `## Full Documentation\n\n`;
  llmsTxt += `- [Full Documentation](${PAGES_BASE}/llms-full.txt): Complete text of all documentation in a single file\n\n`;

  // Group pages by section
  const sections = {};
  for (const page of pagesInfo) {
    // Determine section from pathSegment (first directory level)
    let sectionName = 'General';
    if (page.pathSegment) {
      const parts = page.pathSegment.split('/');
      if (parts.length > 1) {
        sectionName = parts[0]
          .split('-')
          .map(w => w.charAt(0).toUpperCase() + w.slice(1))
          .join(' ');
      }
    } else {
      sectionName = 'Introduction';
    }

    if (!sections[sectionName]) {
      sections[sectionName] = [];
    }
    sections[sectionName].push(page);
  }

  // Write grouped pages in llms.txt
  for (const [sectionName, secPages] of Object.entries(sections)) {
    llmsTxt += `## ${sectionName}\n\n`;
    for (const page of secPages) {
      llmsTxt += `- [${page.title}](${page.url})${page.description ? ': ' + page.description : ''}\n`;
    }
    llmsTxt += `\n`;
  }

  writeFileSync(join(publicDir, 'llms.txt'), llmsTxt);
  console.log('[docs-versions] llms.txt generated');

  // 2. Generate docs/public/llms-full.txt
  let llmsFullTxt = `# Chaos Maker - Full Documentation\n\n`;
  llmsFullTxt += `This file contains the complete documentation for Chaos Maker, concatenated into a single file for easy AI consumption.\n\n`;
  llmsFullTxt += `Latest stable release: ${latestTag}\n\n`;
  llmsFullTxt += `---\n\n`;

  for (const page of pagesInfo) {
    llmsFullTxt += `# Page: ${page.title}\n`;
    llmsFullTxt += `URL: ${BASE_URL}${page.url}\n\n`;
    llmsFullTxt += `${page.content}\n\n`;
    llmsFullTxt += `---\n\n`;
  }

  writeFileSync(join(publicDir, 'llms-full.txt'), llmsFullTxt);
  console.log('[docs-versions] llms-full.txt generated');
}

function main() {
  const tags = listVersionTags().sort(compareTag);
  if (tags.length === 0) {
    throw new Error(
      '[docs-versions] no v*.*.* tags found  -  fetch tags before building',
    );
  }
  // `/latest/` mirrors a published npm release, so it must track the newest
  // stable tag and never a release candidate. Prerelease tags are still laid
  // down under their own slug for users following a v0.X.Y-rc.N preview.
  const stableTags = tags.filter((t) => isStable(parseTag(t)));
  if (stableTags.length === 0) {
    throw new Error(
      '[docs-versions] no stable v*.*.* tags found  -  /latest/ requires one',
    );
  }
  const latestTag = stableTags[stableTags.length - 1];

  console.log(`[docs-versions] tags=[${tags.join(', ')}] latest=${latestTag}`);

  clean();

  // Collect manifest entries as we extract so versions.json reflects exactly
  // what shipped to the filesystem (a tag missing docs is skipped from both
  // sides). Order: latest first, then tags newest → oldest, then main if dev.
  const archivedEntries = [];

  for (const tag of tags) {
    const slug = tagToSlug(tag);
    const dest = join(DOCS_OUT, slug);
    if (!extractTagToDir(tag, dest)) {
      console.warn(`[docs-versions] ${tag} has no docs source; skipping`);
      continue;
    }
    // The canonical versioned slug for the current latest stable serves the
    // same content as /latest/, so it should not wear an "archived" banner
    // until a newer stable tag supersedes it. The manifest still flags only
    // the `/latest/` entry as isLatest  -  the versioned slug stays an archive
    // entry for URL-identity purposes, even when its banner reads "Latest".
    const isCurrentLatest = tag === latestTag;
    const banner = isCurrentLatest
      ? `Latest stable: <strong>${latestTag}</strong>.`
      : `Archived <strong>${tag}</strong> docs. <a href="${PAGES_BASE}/latest/">Latest</a>.`;
    rewriteVersionLinks(dest, slug);
    injectBanner(dest, banner);
    injectEditUrl(dest, slug, isCurrentLatest ? 'enabled' : 'disabled');
    archivedEntries.push({
      slug,
      label: tag,
      tag,
      isLatest: false,
      isMain: false,
      isPrerelease: !isStable(parseTag(tag)),
      pages: collectVersionPages(dest),
    });
    console.log(`[docs-versions]   ${tag} → ${slug}/`);
  }

  const latestDest = join(DOCS_OUT, 'latest');
  if (!extractTagToDir(latestTag, latestDest)) {
    throw new Error(
      `[docs-versions] failed to extract latest tag ${latestTag}`,
    );
  }
  rewriteVersionLinks(latestDest, 'latest');
  injectBanner(
    latestDest,
    `Latest stable: <strong>${latestTag}</strong>.`,
  );
  injectEditUrl(latestDest, 'latest', 'enabled');
  console.log(`[docs-versions]   ${latestTag} → latest/`);

  const latestEntry = {
    slug: 'latest',
    label: `Latest (${latestTag})`,
    tag: latestTag,
    isLatest: true,
    isMain: false,
    isPrerelease: false,
    pages: collectVersionPages(latestDest),
  };

  let mainEntry = null;
  if (isDev) {
    if (existsSync(DEV_SOURCE)) {
      const mainDest = join(DOCS_OUT, 'main');
      cpSync(DEV_SOURCE, mainDest, { recursive: true });
      rewriteVersionLinks(mainDest, 'main');
      injectBanner(
        mainDest,
        `Unreleased <strong>main</strong> preview. <a href="${PAGES_BASE}/latest/">View latest</a>.`,
      );
      injectEditUrl(mainDest, 'main', 'enabled');
      mainEntry = {
        slug: 'main',
        label: 'main (unreleased)',
        tag: null,
        isLatest: false,
        isMain: true,
        isPrerelease: true,
        pages: collectVersionPages(join(DOCS_OUT, 'main')),
      };
      console.log('[docs-versions]   docs/content-source/ → main/ (dev)');
    } else {
      console.warn(
        '[docs-versions] --dev given but docs/content-source/ missing',
      );
    }
  }

  // Dropdown order: `latest` first so newcomers land on the supported
  // version, archived tags next sorted newest → oldest, then `main` last as
  // an opt-in preview. archivedEntries was pushed in tag-asc order.
  const manifestEntries = [
    latestEntry,
    ...archivedEntries.slice().reverse(),
    ...(mainEntry ? [mainEntry] : []),
  ];

  writeRedirectIndex(latestTag);
  writeVersionsManifest(manifestEntries, latestTag);
  generateLlmFiles(latestDest, latestTag);
  console.log('[docs-versions] index.mdx → redirects to /latest/');
  console.log(
    `[docs-versions] versions.json → ${manifestEntries.length} entries`,
  );
}

main();
