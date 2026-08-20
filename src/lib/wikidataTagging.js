// SPEC-06 §6's design-time/onboarding semantic tagging — see
// docs/SPEC-06-CUBO-AGENTIC-HARNESS.md and docs/SPEC-08-CUBO-BUILD-SEQUENCE.md Phase 1.
//
// A backend proxy+cache in front of Wikidata's public APIs, not a direct client-side call, for a
// concrete reason: Wikidata's usage policy requires a compliant, app-identifying User-Agent
// header, which browsers refuse to let JS override (a forbidden header). This also turns every
// ClinuxFlow clinic's query volume into one shared, cacheable budget against Wikidata's real
// rate limit (60s of query time per 60s, per client IP+User-Agent) instead of each browser
// hitting it independently. Same cache-through shape as clinuxflow-abdm-gateway's
// getCachedMasterData() (src/lib/masterData.js there) — deliberately mirrored, not reinvented.
//
// Two-step flow, matching the disambiguation UX both call sites need: search() returns
// candidates for a human to pick from (Wikidata is general-knowledge, not a clinical
// terminology — a "closest match" can be wrong or absent for clinically-precise terms, so this
// never silently auto-picks); getConcept() fetches the full alias/synonym detail only once a
// specific QID has been confirmed.

const USER_AGENT = 'ClinuxFlow/1.0 (https://clinux.yaxb.ai; ClinuxFlow semantic tagging) Cloudflare-Workers-fetch';
const CACHE_TTL_SECONDS = 60 * 60 * 24 * 30; // 30d — a concept's meaning/aliases don't shift fast enough to need less.

function normalizeTerm(term) {
    return term.trim().toLowerCase();
}

async function cached(kv, cacheKey, fetchFn) {
    const hit = await kv.get(cacheKey, 'json');
    if (hit !== null) return { ...hit, cached: true };
    const fresh = await fetchFn();
    await kv.put(cacheKey, JSON.stringify(fresh), { expirationTtl: CACHE_TTL_SECONDS });
    return { ...fresh, cached: false };
}

// Thrown (never silently swallowed) on a real 429 — callers decide how to surface this, but
// must not retry blindly, per Wikidata's own stated policy for clients that ignore 429s.
export class WikidataRateLimitError extends Error {
    constructor(retryAfterSeconds) {
        super(`Wikidata rate limit hit — retry after ${retryAfterSeconds ?? 'unknown'}s`);
        this.name = 'WikidataRateLimitError';
        this.retryAfterSeconds = retryAfterSeconds;
    }
}

async function wikidataFetch(url) {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (res.status === 429) {
        const retryAfter = res.headers.get('Retry-After');
        throw new WikidataRateLimitError(retryAfter ? Number(retryAfter) : null);
    }
    if (!res.ok) throw new Error(`Wikidata request failed: ${res.status}`);
    return res.json();
}

export const WikidataTagging = {
    // Candidate matches for a free-text term — cached per normalized term. Returns
    // [{ qid, label, description }], best match first, empty array if nothing matched.
    async search(kv, term) {
        const key = `wd:search:${normalizeTerm(term)}`;
        const result = await cached(kv, key, async () => {
            const url = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(term)}&language=en&format=json&type=item&limit=5`;
            const body = await wikidataFetch(url);
            const candidates = (body.search || []).map((item) => ({
                qid: item.id,
                label: item.label || item.id,
                description: item.description || '',
            }));
            return { candidates };
        });
        return result.candidates;
    },

    // Full detail for a CONFIRMED qid — aliases are what actually get appended to a form
    // field's keywords or stored against an onboarding role tag; wbsearchentities above doesn't
    // return them, this is a separate call by design (see file header on why search/getConcept
    // are two steps, not one).
    async getConcept(kv, qid) {
        const key = `wd:concept:${qid}`;
        const { cached: _cached, ...concept } = await cached(kv, key, async () => {
            const url = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${encodeURIComponent(qid)}&languages=en&format=json&props=labels|descriptions|aliases`;
            const body = await wikidataFetch(url);
            const entity = body.entities?.[qid];
            if (!entity || !entity.labels) return { qid, label: null, description: '', aliases: [] };
            return {
                qid,
                label: entity.labels?.en?.value ?? null,
                description: entity.descriptions?.en?.value ?? '',
                aliases: (entity.aliases?.en || []).map((a) => a.value),
            };
        });
        return concept;
    },
};
