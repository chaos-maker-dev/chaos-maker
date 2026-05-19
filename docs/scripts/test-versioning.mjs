#!/usr/bin/env node
/**
 * Validates the docs versioning pipeline end-to-end.
 *
 * Assumes `docs/dist/` exists (run `pnpm --filter chaos-maker-docs build:dev`
 * first; CI runs that build before this script). Failures abort with a
 * descriptive message and exit code 1.
 *
 * Coverage:
 *   - Sidebar isolation: a v0-4-0 page's sidebar links never reference
 *     /latest/, /main/, or any other version slug.
 *   - Internal link rewriting: archived-version pages stay inside their own
 *     namespace (no `/latest/` jump-outs from archived snapshots' bodies).
 *   - Cross-version navigation: prev/next pagination links live in the same
 *     version slug as the page that emits them.
 *   - Version selector behaviour: the selector renders on every versioned
 *     page, the active option matches the URL, and the embedded manifest
 *     includes every version listed in src/generated/versions.json.
 *   - Latest semantics: `latest/` content matches the newest stable git tag.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compareTag, isStable, parseTag } from './semver.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS_ROOT = resolve(__dirname, '..');
const DIST = join(DOCS_ROOT, 'dist');
const REPO_ROOT = resolve(__dirname, '../..');
const MANIFEST_PATH = join(DOCS_ROOT, 'src/generated/versions.json');
const BASE = '/chaos-maker';

const failures = [];
function fail(msg) { failures.push(msg); }
function check(cond, msg) { if (!cond) fail(msg); }

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

function listHtmlPages(slugDir) {
  const root = join(DIST, slugDir);
  if (!existsSync(root)) return [];
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) { walk(full); continue; }
      if (entry === 'index.html') out.push(full);
    }
  };
  walk(root);
  return out;
}

// Extract every href that targets the configured Astro base (`/chaos-maker`).
// External links and fragment anchors are ignored — the goal is to verify
// that internal navigation respects version namespace boundaries.
function extractInternalHrefs(html) {
  const re = /href="([^"]+)"/g;
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = m[1];
    if (!href.startsWith(`${BASE}/`)) continue;
    if (href.endsWith('sitemap-index.xml')) continue;
    if (href.endsWith('.svg') || href.endsWith('.css') || href.endsWith('.js')) continue;
    if (href.startsWith(`${BASE}/_astro/`)) continue;
    out.push(href);
  }
  return out;
}

// Extract just the sidebar links: Starlight wraps the sidebar in a <nav>
// labelled "Main" or `aria-label="Main"`. Limit to that scope so this test
// doesn't fire on banner links (which legitimately point at /latest/).
function extractSidebarHrefs(html) {
  const navMatch = /<nav[^>]*aria-label="Main"[^>]*>([\s\S]*?)<\/nav>/i.exec(html);
  if (!navMatch) return null;
  return extractInternalHrefs(navMatch[1]);
}

function extractPaginationHrefs(html) {
  // Starlight's Pagination.astro renders prev/next inside a <div class="pagination-links">.
  const m = /<div[^>]*class="pagination-links[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i.exec(html);
  if (!m) return [];
  return extractInternalHrefs(m[1]);
}

function readManifest() {
  if (!existsSync(MANIFEST_PATH)) {
    throw new Error(`expected ${MANIFEST_PATH}; build docs first`);
  }
  return readJson(MANIFEST_PATH);
}

function expectedLatestTag() {
  const tags = execFileSync('git', ['tag', '-l', 'v*.*.*'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .filter((t) => parseTag(t) !== null)
    .sort(compareTag)
    .filter((t) => isStable(parseTag(t)));
  return tags[tags.length - 1] || null;
}

// 1. Sidebar isolation per version.
function testSidebarIsolation(manifest) {
  const versionSlugs = manifest.versions.map((v) => v.slug);
  for (const version of manifest.versions) {
    const pages = listHtmlPages(version.slug);
    if (pages.length === 0) {
      fail(`no built pages for version ${version.slug}`);
      continue;
    }
    const sample = pages.find((p) => p.endsWith('getting-started/install/index.html'))
      || pages[0];
    const html = readFileSync(sample, 'utf8');
    const links = extractSidebarHrefs(html);
    if (links === null) {
      // Splash pages have no sidebar; that's fine.
      continue;
    }
    for (const link of links) {
      const segments = link.slice(BASE.length).split('/').filter(Boolean);
      const linkSlug = segments[0];
      if (!versionSlugs.includes(linkSlug)) continue;
      check(
        linkSlug === version.slug,
        `sidebar isolation: ${relative(DIST, sample)} references ${link} (foreign version ${linkSlug})`,
      );
    }
  }
}

// 2. Internal links inside archived versions stay in their namespace.
//    The banner link to /latest/ is the one allowed exception; it lives
//    outside the article body in <div class="sl-banner">.
function testInternalLinkRewrite(manifest) {
  for (const version of manifest.versions) {
    if (version.isLatest) continue;
    const pages = listHtmlPages(version.slug);
    for (const page of pages) {
      const html = readFileSync(page, 'utf8');
      const articleMatch = /<main[^>]*>([\s\S]*?)<\/main>/i.exec(html);
      if (!articleMatch) continue;
      const article = articleMatch[1].replace(
        /<div[^>]*class="[^"]*sl-banner[^"]*"[^>]*>[\s\S]*?<\/div>/gi,
        '',
      );
      const links = extractInternalHrefs(article);
      for (const link of links) {
        const segments = link.slice(BASE.length).split('/').filter(Boolean);
        const linkSlug = segments[0];
        // Allow the splash/redirect index (`/chaos-maker/`).
        if (segments.length === 0) continue;
        if (linkSlug === version.slug) continue;
        // Allow links that target a non-version path (none should exist post-rewrite).
        const known = manifest.versions.some((v) => v.slug === linkSlug);
        if (!known) continue;
        fail(
          `link leak: ${relative(DIST, page)} body links to ${link} (foreign version ${linkSlug})`,
        );
      }
    }
  }
}

// 3. Pagination prev/next confined to source version.
function testPaginationScope(manifest) {
  for (const version of manifest.versions) {
    const pages = listHtmlPages(version.slug);
    for (const page of pages) {
      const html = readFileSync(page, 'utf8');
      const links = extractPaginationHrefs(html);
      for (const link of links) {
        const segments = link.slice(BASE.length).split('/').filter(Boolean);
        const linkSlug = segments[0];
        check(
          linkSlug === version.slug,
          `pagination: ${relative(DIST, page)} prev/next jumps into ${linkSlug}`,
        );
      }
    }
  }
}

// 4. Version selector renders + embedded manifest matches versions.json.
//    Tested on every page in the version (splash + non-splash) — splash pages
//    have no sidebar but the dropdown lives in the header and must still work.
//    The archived snapshot whose tag equals `manifest.latestTag` is the twin
//    of `latest/` and is hidden from the dropdown to avoid a duplicate
//    "Latest (v0.X.0)" + "v0.X.0" pair; on those pages the dropdown surfaces
//    `latest` as the preselected option instead.
function testVersionSelector(manifest) {
  const isDropdownTwin = (v) =>
    !v.isLatest && v.tag === manifest.latestTag;
  const dropdownVersions = manifest.versions.filter((v) => !isDropdownTwin(v));
  for (const version of manifest.versions) {
    const pages = listHtmlPages(version.slug);
    if (pages.length === 0) continue;
    const twin = isDropdownTwin(version);
    for (const page of pages) {
      const html = readFileSync(page, 'utf8');
      const rel = relative(DIST, page);
      check(
        /class="version-select(?:\s|"|\b)/.test(html),
        `selector missing on ${rel}`,
      );
      check(
        new RegExp(`data-active="${version.slug}"`).test(html),
        `selector active flag wrong on ${rel}`,
      );
      const preselectedSlug = twin ? 'latest' : version.slug;
      check(
        new RegExp(`<option value="${preselectedSlug}" selected`).test(html),
        `selector preselect wrong on ${rel}`,
      );
      for (const v of dropdownVersions) {
        check(
          new RegExp(`<option value="${v.slug}"`).test(html),
          `selector missing option for ${v.slug} on ${rel}`,
        );
      }
      if (twin) {
        check(
          !new RegExp(`<option value="${version.slug}"`).test(html),
          `selector should hide archived twin ${version.slug} of latest on ${rel}`,
        );
      }
    }
  }
}

// 5. `latest` slug content equals the newest stable git tag.
function testLatestSemantics(manifest) {
  const tag = expectedLatestTag();
  check(tag !== null, 'no stable git tag found');
  check(
    manifest.latestTag === tag,
    `manifest.latestTag (${manifest.latestTag}) does not match newest stable tag (${tag})`,
  );
  const latest = manifest.versions.find((v) => v.isLatest);
  check(latest && latest.tag === tag, `latest entry tag mismatch (got ${latest?.tag}, want ${tag})`);
  // Slugify the tag the same way the build does.
  const expectedSlug = tag.replace(/\./g, '-');
  const archived = manifest.versions.find((v) => v.slug === expectedSlug);
  check(
    archived !== undefined,
    `archived snapshot for ${tag} (slug ${expectedSlug}) missing from manifest`,
  );
  // Page lists must be identical between latest and the matching archive.
  if (latest && archived) {
    check(
      JSON.stringify(latest.pages) === JSON.stringify(archived.pages),
      `latest/ pages differ from ${expectedSlug}/ pages — latest is not tracking the newest stable tag`,
    );
  }
}

function main() {
  if (!existsSync(DIST)) {
    console.error(`[docs-test] ${DIST} missing — run \`pnpm build:dev\` first`);
    process.exit(2);
  }
  const manifest = readManifest();
  console.log(`[docs-test] testing ${manifest.versions.length} versions`);
  testSidebarIsolation(manifest);
  testInternalLinkRewrite(manifest);
  testPaginationScope(manifest);
  testVersionSelector(manifest);
  testLatestSemantics(manifest);

  if (failures.length > 0) {
    console.error(`[docs-test] FAIL — ${failures.length} issue(s):`);
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
  }
  console.log('[docs-test] PASS — all version isolation checks green');
}

main();
