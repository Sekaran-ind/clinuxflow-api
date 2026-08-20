import { describe, it, expect, vi, afterEach } from 'vitest';
import { WikidataTagging, WikidataRateLimitError } from './wikidataTagging.js';

function fakeFetch(status, body, headers = {}) {
    return vi.fn().mockResolvedValue({
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (name) => headers[name] ?? null },
        json: async () => body,
    });
}

function fakeKv(initial = {}) {
    const store = { ...initial };
    return {
        get: vi.fn(async (key, type) => (key in store ? (type === 'json' ? JSON.parse(store[key]) : store[key]) : null)),
        put: vi.fn(async (key, value) => { store[key] = value; }),
        _store: store,
    };
}

afterEach(() => vi.unstubAllGlobals());

describe('WikidataTagging.search', () => {
    it('sends a compliant User-Agent — required by Wikidata policy, and browsers cannot set this themselves', async () => {
        const fetchSpy = fakeFetch(200, { search: [] });
        vi.stubGlobal('fetch', fetchSpy);
        await WikidataTagging.search(fakeKv(), 'internal medicine');
        const [, options] = fetchSpy.mock.calls[0];
        expect(options.headers['User-Agent']).toMatch(/ClinuxFlow/);
    });

    it('maps wbsearchentities results to { qid, label, description }, best match first', async () => {
        vi.stubGlobal('fetch', fakeFetch(200, {
            search: [
                { id: 'Q11180', label: 'internal medicine', description: 'medical specialty dealing with diseases of internal organs' },
                { id: 'Q6047666', label: 'Internal Medicine', description: 'scientific journal' },
            ],
        }));
        const candidates = await WikidataTagging.search(fakeKv(), 'internal medicine');
        expect(candidates).toEqual([
            { qid: 'Q11180', label: 'internal medicine', description: 'medical specialty dealing with diseases of internal organs' },
            { qid: 'Q6047666', label: 'Internal Medicine', description: 'scientific journal' },
        ]);
    });

    it('caches by normalized term — a second call with different casing/whitespace is a cache hit, no second fetch', async () => {
        const fetchSpy = fakeFetch(200, { search: [{ id: 'Q10379', label: 'cardiology', description: 'medical specialty' }] });
        vi.stubGlobal('fetch', fetchSpy);
        const kv = fakeKv();
        await WikidataTagging.search(kv, 'Cardiology');
        await WikidataTagging.search(kv, '  cardiology  ');
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('throws WikidataRateLimitError with the Retry-After value on a real 429', async () => {
        vi.stubGlobal('fetch', fakeFetch(429, {}, { 'Retry-After': '30' }));
        await expect(WikidataTagging.search(fakeKv(), 'x')).rejects.toThrow(WikidataRateLimitError);
        try {
            await WikidataTagging.search(fakeKv(), 'x');
        } catch (err) {
            expect(err.retryAfterSeconds).toBe(30);
        }
    });

    it('returns an empty array when Wikidata has no matches, not an error', async () => {
        vi.stubGlobal('fetch', fakeFetch(200, { search: [] }));
        expect(await WikidataTagging.search(fakeKv(), 'zzzznonexistentterm')).toEqual([]);
    });
});

describe('WikidataTagging.getConcept', () => {
    it('fetches aliases/labels/descriptions for a confirmed qid', async () => {
        vi.stubGlobal('fetch', fakeFetch(200, {
            entities: {
                Q11180: {
                    labels: { en: { value: 'internal medicine' } },
                    descriptions: { en: { value: 'medical specialty' } },
                    aliases: { en: [{ value: 'general medicine' }, { value: 'internal med' }] },
                },
            },
        }));
        const concept = await WikidataTagging.getConcept(fakeKv(), 'Q11180');
        expect(concept).toMatchObject({
            qid: 'Q11180',
            label: 'internal medicine',
            description: 'medical specialty',
            aliases: ['general medicine', 'internal med'],
        });
    });

    it('handles a qid with no English aliases gracefully — empty array, not an error', async () => {
        vi.stubGlobal('fetch', fakeFetch(200, {
            entities: { Q1: { labels: { en: { value: 'x' } }, descriptions: {}, aliases: {} } },
        }));
        const concept = await WikidataTagging.getConcept(fakeKv(), 'Q1');
        expect(concept.aliases).toEqual([]);
    });

    it('handles an unknown/unlabeled qid (confirmed real case: Wikidata has stub/deleted items) without throwing', async () => {
        vi.stubGlobal('fetch', fakeFetch(200, { entities: { Q4114464: { labels: {} } } }));
        const concept = await WikidataTagging.getConcept(fakeKv(), 'Q4114464');
        expect(concept).toEqual({ qid: 'Q4114464', label: null, description: '', aliases: [] });
    });

    it('caches by qid', async () => {
        const fetchSpy = fakeFetch(200, { entities: { Q1: { labels: { en: { value: 'x' } }, descriptions: {}, aliases: {} } } });
        vi.stubGlobal('fetch', fetchSpy);
        const kv = fakeKv();
        await WikidataTagging.getConcept(kv, 'Q1');
        await WikidataTagging.getConcept(kv, 'Q1');
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
});
