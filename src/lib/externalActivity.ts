import { XMLParser } from 'fast-xml-parser';
import fallbackData from '../data/external-activity-fallback.json';

const GOODREADS_CURRENT_URL = 'https://www.goodreads.com/review/list_rss/74346487?shelf=currently-reading';
const GOODREADS_READ_URL = 'https://www.goodreads.com/review/list_rss/74346487?shelf=read&sort=date_read&order=d';
const DOUBAN_INTERESTS_URL = 'https://www.douban.com/feed/people/crazytan/interests';

const parser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  trimValues: true,
});

export type ActivityKind = 'book' | 'movie' | 'game';

export interface ActivityItem {
  kind: ActivityKind;
  title: string;
  creator?: string;
  url: string;
  status: string;
  date?: string;
}

export interface ExternalActivity {
  book: ActivityItem;
  movie: ActivityItem;
  game: ActivityItem;
  updatedAt: string;
  hasFallback: boolean;
}

interface RssItem {
  title?: unknown;
  link?: unknown;
  guid?: unknown;
  pubDate?: unknown;
  author_name?: unknown;
  user_read_at?: unknown;
}

const fallback: ExternalActivity = {
  ...fallbackData,
  book: { ...fallbackData.book, kind: 'book' },
  movie: { ...fallbackData.movie, kind: 'movie' },
  game: { ...fallbackData.game, kind: 'game' },
  hasFallback: true,
};

let activityPromise: Promise<ExternalActivity> | undefined;

function text(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  if (value && typeof value === 'object' && '#text' in value) {
    return text((value as { '#text': unknown })['#text']);
  }
  return '';
}

function itemsFrom(xml: string): RssItem[] {
  const parsed = parser.parse(xml) as {
    rss?: { channel?: { item?: RssItem | RssItem[] } };
  };
  const items = parsed.rss?.channel?.item;
  if (!items) return [];
  return Array.isArray(items) ? items : [items];
}

function isoDate(value: unknown): string | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  const date = new Date(raw);
  if (Number.isNaN(date.valueOf())) return undefined;
  return date.toISOString().slice(0, 10);
}

async function fetchFeed(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);

  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8',
        'User-Agent': 'Mozilla/5.0 (compatible; crazytan.dev/1.0; +https://crazytan.dev/)',
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Feed returned ${response.status}`);
    }

    return response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeBook(item: RssItem, status: string): ActivityItem | undefined {
  const title = text(item.title);
  const url = text(item.link) || text(item.guid);
  if (!title || !url) return undefined;

  return {
    kind: 'book',
    title,
    creator: text(item.author_name) || undefined,
    url,
    status,
    date: isoDate(item.user_read_at) ?? isoDate(item.pubDate),
  };
}

async function loadBook(): Promise<ActivityItem> {
  const currentItems = itemsFrom(await fetchFeed(GOODREADS_CURRENT_URL));
  const current = currentItems[0] && normalizeBook(currentItems[0], 'Currently reading');
  if (current) return current;

  const readItems = itemsFrom(await fetchFeed(GOODREADS_READ_URL));
  return normalizeBook(readItems[0] ?? {}, 'Recently read') ?? fallback.book;
}

const movieStates = [
  ['在看', 'Watching'],
  ['看过', 'Watched'],
  ['想看', 'Want to watch'],
] as const;

const gameStates = [
  ['在玩', 'Playing'],
  ['玩过', 'Played'],
  ['想玩', 'Want to play'],
] as const;

function normalizeDouban(item: RssItem): ActivityItem | undefined {
  const url = text(item.link);
  const rawTitle = text(item.title);
  if (!url || !rawTitle) return undefined;

  const kind: ActivityKind | undefined = url.includes('movie.douban.com/subject/')
    ? 'movie'
    : url.includes('/game/')
      ? 'game'
      : undefined;
  if (!kind) return undefined;

  const states = kind === 'movie' ? movieStates : gameStates;
  const match = states.find(([prefix]) => rawTitle.startsWith(prefix));
  const title = match ? rawTitle.slice(match[0].length).trim() : rawTitle;

  return {
    kind,
    title,
    url: url.replace('http://', 'https://'),
    status: match?.[1] ?? (kind === 'movie' ? 'Movie activity' : 'Game activity'),
    date: isoDate(item.pubDate),
  };
}

async function loadDouban(): Promise<{ movie: ActivityItem; game: ActivityItem }> {
  const items = itemsFrom(await fetchFeed(DOUBAN_INTERESTS_URL));
  const normalized = items.map(normalizeDouban).filter((item): item is ActivityItem => Boolean(item));

  return {
    movie: normalized.find((item) => item.kind === 'movie') ?? fallback.movie,
    game: normalized.find((item) => item.kind === 'game') ?? fallback.game,
  };
}

async function loadExternalActivity(): Promise<ExternalActivity> {
  const [bookResult, doubanResult] = await Promise.allSettled([loadBook(), loadDouban()]);
  const book = bookResult.status === 'fulfilled' ? bookResult.value : fallback.book;
  const douban = doubanResult.status === 'fulfilled'
    ? doubanResult.value
    : { movie: fallback.movie, game: fallback.game };
  const hasFallback = bookResult.status === 'rejected' || doubanResult.status === 'rejected';

  return {
    book,
    movie: douban.movie,
    game: douban.game,
    updatedAt: hasFallback ? fallback.updatedAt : new Date().toISOString(),
    hasFallback,
  };
}

export function getExternalActivity(): Promise<ExternalActivity> {
  activityPromise ??= loadExternalActivity();
  return activityPromise;
}

export function formatActivityDate(value?: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(date.valueOf())) return undefined;

  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

export function formatUpdatedAt(value: string): string {
  const date = new Date(value);
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'America/Los_Angeles',
  }).format(date);
}
