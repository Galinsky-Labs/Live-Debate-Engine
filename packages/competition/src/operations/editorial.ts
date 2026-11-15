import { deepFreeze, fail, instant, list, ms, oneOf, record, str, uuid, type Context } from './common.js';
import { defineStream } from './stream.js';

/** E-34: editorial publishing (summaries, articles, highlight notes) with two-person approval and embargo. */
export const CHANNELS = ['public-site', 'newsletter', 'syndication', 'social'] as const;
export type Article = Readonly<{ articleId: string; kind: 'summary' | 'article' | 'highlight' | 'press-release'; headline: string; body: string; channels: readonly typeof CHANNELS[number][];
  status: 'draft' | 'in-review' | 'approved' | 'published' | 'withdrawn'; author: string; reviewer: string | null; publishAt: string | null; revision: number;
  history: readonly Readonly<{ at: string; by: string; action: string; note: string | null }>[] }>;
export type EditorialState = Readonly<{ articles: readonly Article[] }>;
export function initialEditorial(): EditorialState { return deepFreeze({ articles: [] }); }
/** Public visibility: published and past its embargo. */
export function visibleArticles(state: EditorialState, now: string): readonly Article[] {
  return state.articles.filter((a) => a.status === 'published' && a.publishAt !== null && ms(a.publishAt) <= ms(now));
}
export function applyEditorial(state: EditorialState, type: string, input: unknown, context: Context): EditorialState {
  const find = (id: unknown) => state.articles.find((a) => a.articleId === id) ?? fail('unknown_article');
  const swap = (a: Article, next: Partial<Article>, action: string, note: string | null = null) => deepFreeze({ articles: state.articles.map((x) => x === a ? { ...a, ...next, history: [...a.history, { at: context.now, by: context.actor, action, note }].slice(-30) } : x) });
  switch (type) {
    case 'draft': {
      const p = record(input, ['articleId', 'kind', 'headline', 'body', 'channels']);
      const id = uuid(p.articleId, 'article'); const existing = state.articles.find((a) => a.articleId === id);
      if (existing && !['draft', 'in-review'].includes(existing.status)) fail('article_locked', 409);
      if (existing && existing.author !== context.actor) fail('not_author', 403);
      const channels = list(p.channels, (c) => oneOf(c, CHANNELS, 'channel'), 'channels', 1, 4);
      const article: Article = { articleId: id, kind: oneOf(p.kind, ['summary', 'article', 'highlight', 'press-release'] as const, 'kind'), headline: str(p.headline, 'headline', 5, 200), body: str(p.body, 'body', 20, 20000),
        channels: [...new Set(channels)], status: 'draft', author: context.actor, reviewer: null, publishAt: null, revision: (existing?.revision ?? 0) + 1, history: [...(existing?.history ?? []), { at: context.now, by: context.actor, action: 'draft', note: null }].slice(-30) };
      if (!existing && state.articles.length >= 50) fail('too_many_articles');
      return deepFreeze({ articles: [...state.articles.filter((a) => a.articleId !== id), article] });
    }
    case 'submit': { const a = find(record(input, ['articleId']).articleId); if (a.status !== 'draft' || a.author !== context.actor) fail('cannot_submit', 409); return swap(a, { status: 'in-review' }, 'submit'); }
    case 'approve': case 'requestChanges': {
      const p = record(input, ['articleId', 'note']); const a = find(p.articleId);
      if (a.status !== 'in-review') fail('not_in_review', 409);
      if (a.author === context.actor) fail('author_cannot_review', 403);
      return swap(a, type === 'approve' ? { status: 'approved', reviewer: context.actor } : { status: 'draft' }, type, str(p.note, 'note', 3, 1000));
    }
    case 'publish': {
      const p = record(input, ['articleId', 'publishAt']); const a = find(p.articleId);
      if (a.status !== 'approved') fail('not_approved', 409);
      const at = instant(p.publishAt);
      return swap(a, { status: 'published', publishAt: ms(at) < ms(context.now) ? context.now : at }, 'publish');
    }
    case 'withdraw': {
      const p = record(input, ['articleId', 'reason']); const a = find(p.articleId);
      if (a.status !== 'published' && a.status !== 'approved') fail('not_published', 409);
      return swap(a, { status: 'withdrawn' }, 'withdraw', str(p.reason, 'reason', 10, 1000));
    }
    default: return fail('unknown_command', 400);
  }
}
const cmd = (type: string) => ({ action: 'event.manage' as const, apply: (s: EditorialState, p: unknown, c: Context) => applyEditorial(s, type, p, c) });
export const editorialStream = defineStream<EditorialState>({ name: 'editorial', readAction: 'event.manage', initial: initialEditorial,
  commands: Object.fromEntries(['draft', 'submit', 'approve', 'requestChanges', 'publish', 'withdraw'].map((t) => [t, cmd(t)])) });
