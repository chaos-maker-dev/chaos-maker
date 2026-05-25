import { defineRouteMiddleware } from '@astrojs/starlight/route-data';
import type {
  PaginationLinks,
  SidebarEntry,
  SidebarGroup,
  SidebarLink,
  StarlightRouteData,
} from '@astrojs/starlight/route-data';
import versionsData from './generated/versions.json';

interface VersionEntry {
  slug: string;
  label: string;
  tag: string | null;
  isLatest: boolean;
  isMain: boolean;
  isPrerelease: boolean;
  pages: string[];
}

interface VersionsManifest {
  base: string;
  latestTag: string;
  versions: VersionEntry[];
}

const manifest = versionsData as VersionsManifest;
const VERSION_SLUGS = new Set(manifest.versions.map((v) => v.slug));
const BASE = stripTrailing(manifest.base);

function stripTrailing(p: string): string {
  return p.endsWith('/') ? p.slice(0, -1) : p;
}

// Strip the configured Astro `base` from a pathname. Browsers send
// `/chaos-maker/v0-4-0/...`; with no base we want `/v0-4-0/...`. Only matches
// on a segment boundary so an unrelated prefix like `/chaos-maker-v2` is
// returned untouched.
function stripBase(pathname: string): string {
  if (!BASE) return pathname;
  if (pathname === BASE) return '/';
  if (pathname.startsWith(BASE + '/')) return pathname.slice(BASE.length);
  return pathname;
}

// First path segment that matches a known version slug. Returns null for
// the redirect index page (`/` or `/chaos-maker/`) and any unknown route.
export function activeVersionSlug(pathname: string): string | null {
  const stripped = stripBase(pathname);
  const segments = stripped.split('/').filter(Boolean);
  if (segments.length === 0) return null;
  const first = segments[0];
  return VERSION_SLUGS.has(first) ? first : null;
}

// Group keys are exactly the version slugs  -  see astro.config.mjs. Returning
// the entries (not the wrapping group) lets the rendered sidebar look like
// "Adapters / API / ...", with no top-level version label.
function findVersionGroupEntries(
  sidebar: SidebarEntry[],
  slug: string,
): SidebarEntry[] | null {
  for (const entry of sidebar) {
    if (entry.type === 'group' && entry.label === slug) {
      return entry.entries;
    }
  }
  return null;
}

function flatten(entries: SidebarEntry[]): SidebarLink[] {
  const out: SidebarLink[] = [];
  for (const entry of entries) {
    if (entry.type === 'link') out.push(entry);
    else out.push(...flatten(entry.entries));
  }
  return out;
}

// Rebuild prev/next strictly within the version-scoped sidebar so a v0-4-0
// page can't paginate into latest. Mirrors Starlight's own algorithm: find
// the current entry, take its neighbours.
function recomputePagination(sidebar: SidebarEntry[]): PaginationLinks {
  const links = flatten(sidebar);
  const idx = links.findIndex((l) => l.isCurrent);
  if (idx === -1) return { prev: undefined, next: undefined };
  return {
    prev: idx > 0 ? links[idx - 1] : undefined,
    next: idx < links.length - 1 ? links[idx + 1] : undefined,
  };
}

declare module 'astro' {
  // Surface manifest + active slug to components without a second import.
  // VersionSelect.astro reads these from `Astro.locals.starlightRoute`.
  interface StarlightRouteData {
    versions?: VersionEntry[];
    activeVersion?: VersionEntry | null;
  }
}

export const onRequest = defineRouteMiddleware(async (context, next) => {
  await next();
  const route = context.locals.starlightRoute as StarlightRouteData & {
    versions?: VersionEntry[];
    activeVersion?: VersionEntry | null;
  };
  const slug = activeVersionSlug(context.url.pathname);

  // Always expose the manifest. Splash/redirect pages get a null active
  // version so the selector still renders but nothing is preselected.
  route.versions = manifest.versions;
  route.activeVersion = slug
    ? manifest.versions.find((v) => v.slug === slug) ?? null
    : null;

  if (!slug) return;

  const filtered = findVersionGroupEntries(route.sidebar, slug);
  if (!filtered) return;

  // Recursively prune any nested group whose label is also a version slug  - 
  // defensive against future autogenerate changes that might nest differently.
  const prune = (entries: SidebarEntry[]): SidebarEntry[] =>
    entries
      .filter(
        (e) => !(e.type === 'group' && VERSION_SLUGS.has(e.label) && e.label !== slug),
      )
      .map((e) =>
        e.type === 'group'
          ? ({ ...e, entries: prune(e.entries) } as SidebarGroup)
          : e,
      );

  route.sidebar = prune(filtered);
  route.pagination = recomputePagination(route.sidebar);
});
