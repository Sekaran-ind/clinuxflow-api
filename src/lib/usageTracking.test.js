import { describe, it, expect, vi } from 'vitest';
import { UsageTracking } from './usageTracking.js';

// Minimal fake of the D1 prepare().bind().run()/.all() chain, matching the shape used throughout
// this codebase's other lib tests (e.g. encounter-coordination-db.js's own tests).
function fakeDb({ runResult = { meta: {} }, allResult = { results: [] } } = {}) {
    const bind = vi.fn(() => ({ run: vi.fn().mockResolvedValue(runResult), all: vi.fn().mockResolvedValue(allResult) }));
    const prepare = vi.fn(() => ({ bind }));
    return { prepare, bind, sql: null };
}

describe('UsageTracking.record', () => {
    it('upserts a (clinic, date, component) row with the given quantity', async () => {
        const db = fakeDb();
        await UsageTracking.record(db, 'clinic1', 'd1_write', 3);
        expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO clinic_usage_daily'));
        expect(db.bind).toHaveBeenCalledWith('clinic1', expect.any(String), 'd1_write', 3);
    });

    it('defaults quantity to 1', async () => {
        const db = fakeDb();
        await UsageTracking.record(db, 'clinic1', 'workers_ai_call');
        expect(db.bind).toHaveBeenCalledWith('clinic1', expect.any(String), 'workers_ai_call', 1);
    });

    it('no-ops on a missing clinicId — nothing to attribute', async () => {
        const db = fakeDb();
        await UsageTracking.record(db, null, 'd1_write', 5);
        expect(db.prepare).not.toHaveBeenCalled();
    });

    it('no-ops on a zero quantity', async () => {
        const db = fakeDb();
        await UsageTracking.record(db, 'clinic1', 'd1_write', 0);
        expect(db.prepare).not.toHaveBeenCalled();
    });

    it('swallows its own errors — a metering hiccup must never fail the real request', async () => {
        const db = { prepare: vi.fn(() => { throw new Error('D1 unavailable'); }) };
        vi.spyOn(console, 'error').mockImplementation(() => {});
        await expect(UsageTracking.record(db, 'clinic1', 'd1_write', 1)).resolves.toBeUndefined();
    });
});

describe('UsageTracking.recordWrite', () => {
    it("uses the D1 result's real rows_written", async () => {
        const db = fakeDb();
        const recordSpy = vi.spyOn(UsageTracking, 'record');
        await UsageTracking.recordWrite(db, 'clinic1', { meta: { rows_written: 4 } });
        expect(recordSpy).toHaveBeenCalledWith(db, 'clinic1', 'd1_write', 4);
    });

    it('falls back to 1 when meta is missing — a write is never silently uncounted', async () => {
        const db = fakeDb();
        const recordSpy = vi.spyOn(UsageTracking, 'record');
        await UsageTracking.recordWrite(db, 'clinic1', undefined);
        expect(recordSpy).toHaveBeenCalledWith(db, 'clinic1', 'd1_write', 1);
    });

    it('honors a custom component name', async () => {
        const db = fakeDb();
        const recordSpy = vi.spyOn(UsageTracking, 'record');
        await UsageTracking.recordWrite(db, 'clinic1', { meta: { rows_written: 2 } }, 'custom_write');
        expect(recordSpy).toHaveBeenCalledWith(db, 'clinic1', 'custom_write', 2);
    });
});

describe('UsageTracking.recordRead', () => {
    it('always records quantity 1 — reads have no exact row-count signal from D1', async () => {
        const db = fakeDb();
        const recordSpy = vi.spyOn(UsageTracking, 'record');
        await UsageTracking.recordRead(db, 'clinic1');
        expect(recordSpy).toHaveBeenCalledWith(db, 'clinic1', 'd1_read', 1);
    });
});

describe('UsageTracking.summaryForClinic', () => {
    it('queries scoped to the given clinic and day window, returning the raw rows', async () => {
        const rows = [{ date: '2026-08-18', component: 'd1_write', quantity: 3 }];
        const db = fakeDb({ allResult: { results: rows } });
        const out = await UsageTracking.summaryForClinic(db, 'clinic1', 7);
        expect(db.bind).toHaveBeenCalledWith('clinic1', '-7 days');
        expect(out).toEqual(rows);
    });

    it('defaults to a 30-day window', async () => {
        const db = fakeDb();
        await UsageTracking.summaryForClinic(db, 'clinic1');
        expect(db.bind).toHaveBeenCalledWith('clinic1', '-30 days');
    });
});
