import { describe, it, expect, vi, afterEach } from 'vitest';
import app from '../index.js';
import { AccountsDb } from '../lib/shared/accounts-db.js';
import { issueSessionToken } from '../lib/shared/session.js';
import { provenanceProblems } from './provenance.js';

const SERVICE_KEY = 'test-service-key';
const JWT_SECRET = 'test-jwt-secret';
afterEach(() => vi.restoreAllMocks());

function fakeDb() {
    const statements = [];
    return {
        statements,
        prepare(sql) { const st = { sql, args: [] }; return { bind(...a) { st.args = a; statements.push(st); return this; }, all: async () => ({ results: [] }) }; },
        batch: async (list) => list.map(() => ({ success: true })),
    };
}
const prov = (id) => ({
    resourceType: 'Provenance', id, target: [{ reference: `QuestionnaireResponse/${id}` }], recorded: '2026-10-02T10:00:00Z',
    activity: { coding: [{ code: 'CREATE' }] },
    agent: [{ who: { identifier: { system: 'https://doctor.ndhm.gov.in', value: '71-1' } }, onBehalfOf: { identifier: { system: 'https://clinux.yaxb.ai/fhir/sid/clinic', value: 'clinic-1' } } }],
});
const headers = async () => ({ 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${await issueSessionToken({ sub: 'acc-1', clinicId: 'clinic-1', email: 'a@x' }, JWT_SECRET)}` });
const env = (DB) => ({ SERVICE_KEY, JWT_SECRET, DB });

describe('POST /api/provenance', () => {
    it('is paid-plan only: a free clinic gets 403 and nothing is written', async () => {
        vi.spyOn(AccountsDb, 'getClinicById').mockResolvedValue({ tier: 'free' });
        const DB = fakeDb();
        const res = await app.request('/api/provenance', { method: 'POST', headers: await headers(), body: JSON.stringify({ resources: [prov('p1')] }) }, env(DB));
        expect(res.status).toBe(403);
        expect(DB.statements).toEqual([]);
    });

    it('stores a paid clinic\'s batch idempotently, scoped to the caller\'s clinic', async () => {
        vi.spyOn(AccountsDb, 'getClinicById').mockResolvedValue({ tier: 'paid' });
        const DB = fakeDb();
        const res = await app.request('/api/provenance', { method: 'POST', headers: await headers(), body: JSON.stringify({ resources: [prov('p1'), prov('p2')] }) }, env(DB));
        expect(res.status).toBe(201);
        expect(DB.statements).toHaveLength(2);
        expect(DB.statements[0].sql).toMatch(/INSERT OR IGNORE/);
        expect(DB.statements[0].args.slice(0, 5)).toEqual(['p1', 'clinic-1', 'acc-1', 'QuestionnaireResponse/p1', 'CREATE']);
    });

    it('rejects malformed provenance and oversized batches', async () => {
        vi.spyOn(AccountsDb, 'getClinicById').mockResolvedValue({ tier: 'paid' });
        const bad = await app.request('/api/provenance', { method: 'POST', headers: await headers(), body: JSON.stringify({ resources: [{ resourceType: 'Provenance', id: 'x' }] }) }, env(fakeDb()));
        expect(bad.status).toBe(400);
        const big = await app.request('/api/provenance', { method: 'POST', headers: await headers(), body: JSON.stringify({ resources: Array.from({ length: 101 }, (_, i) => prov(`p${i}`)) }) }, env(fakeDb()));
        expect(big.status).toBe(400);
    });

    it('names exactly what is missing', () => {
        expect(provenanceProblems({ resourceType: 'Provenance', id: 'x', target: [], agent: [{}] })).toEqual([
            'at least one target is required', 'recorded is required', 'agent with who and onBehalfOf is required',
        ]);
        expect(provenanceProblems(prov('ok'))).toEqual([]);
    });
});
