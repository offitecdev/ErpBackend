/* E2E 19.09.2026 — der OSP-Ablauf nach dem Umbau, gegen den LAUFENDEN Server.
 *
 * Geprüft wird die Kette, die der Vertrag verlangt (offer-integration-api.md,
 * "Required workflow in the sales system"):
 *
 *   §1  Anfrage herein                     → LISTED   ("Gelistet")
 *   PATCH Verkäufer:in gewählt             → IN_OFFER ("Verkäufer zugewiesen")
 *   §1a Überarbeitung herein               → revisedAt gesetzt, Warnung offen
 *   POST revision-seen                     → Warnung erledigt
 *   PATCH Verkäufer:in entfernt            → zurück auf LISTED
 *   GET by-tender                          → findet die Zeile über die Offerte
 *   DELETE                                 → Zeile weg (Rückzug §4b gemeldet)
 *
 * Das Zugangsmerkmal stellt der EIGENE Dienst aus (Bearer, wie Swagger); kein
 * Kennwort wird angefasst. Die Zeile ist eine WEGWERF-Referenz und wird am Ende
 * entfernt — auch bei einem Abbruch.
 */
import dotenv from 'dotenv';
dotenv.config();
import prisma from '../src/infrastructure/database/prisma.client';
import { jwtTokenService, toPwdAtClaim } from '../src/infrastructure/services/JwtTokenService';

const BASE = 'http://localhost:3000/api/v1';
const REF = '0000000-98';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const rowOf = async () => (prisma as any).ospDocument.findFirst({
    where: { reference: REF },
    select: {
        id: true, status: true, salespersonId: true, salespersonEmail: true,
        salespersonProfile: true, revisedAt: true, revisionCount: true,
        revisionSeenAt: true, lastReportedStatus: true, lastReportError: true,
        tenderId: true,
    },
});

const show = (label: string, row: any) => {
    console.log(`${label.padEnd(28)} status=${row?.status} person=${row?.salespersonEmail ?? '—'}`
        + ` revised=${row?.revisedAt ? 'yes' : 'no'} seen=${row?.revisionSeenAt ? 'yes' : 'no'}`
        + ` reported=${row?.lastReportedStatus ?? '—'}${row?.lastReportError ? ` err=${String(row.lastReportError).slice(0, 60)}` : ''}`);
};

(async () => {
    const setting = await (prisma as any).ospSetting.findFirst({
        where: { NOT: { webhookKey: null } },
        select: { tenantId: true, tenantIds: true, webhookKey: true, ospBaseUrl: true },
    });
    if (!setting?.webhookKey) { console.log('kein Webhook-Schlüssel hinterlegt — nichts zu prüfen.'); process.exit(0); }
    console.log('Feed-Wurzel:', setting.tenantId, '| OSP-Basisadresse:', setting.ospBaseUrl || '(leer → nichts melden)');

    /* Wer den Feed sehen darf, sagt `tenantIds` — die Wurzel selbst hat oft
       gar keine Belegschaft (sie ist die Klammer, nicht die Firma). Genommen
       wird darum eine teilnehmende Firma MIT Leuten; die Zuständigen kommen
       ohnehin aus dem Verzeichnis der ausgewählten Firma, nicht aus der
       Wurzel. */
    const participating: string[] = [setting.tenantId, ...(Array.isArray(setting.tenantIds) ? setting.tenantIds.map(String) : [])];
    const actor = await prisma.employee.findFirst({
        where: { tenantId: { in: participating } },
        select: { id: true, email: true, tenantId: true, passwordChangedAt: true },
    });
    if (!actor) throw new Error('Kein Konto in einer teilnehmenden Firma gefunden.');
    const vendor = await prisma.employee.findFirst({
        where: { tenantId: actor.tenantId },
        orderBy: { createdAt: 'desc' },
        select: { id: true, email: true, firstName: true, lastName: true },
    });
    if (!vendor?.email) throw new Error('Keine Verkäufer:in mit E-Mail-Adresse gefunden.');
    console.log('Handelnde Firma:', actor.tenantId, '| Verkäufer:in:', vendor.email);

    const token = jwtTokenService.generateToken('access', {
        id: actor.id, tenantId: actor.tenantId, email: actor.email,
        pwdAt: toPwdAtClaim(actor.passwordChangedAt),
    } as any);
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    const entry = {
        projectNumber: REF,
        projectName: 'Wegwerf Verkäuferablauf',
        username: 'Test', surname: 'Lauf', email: 'test@example.invalid',
        companyName: 'Wegwerf AG',
        category: 'heat pump', type: 'water to water', model: 'AWRC-150.2CI290',
        created_at: new Date().toISOString().slice(0, 23),
    };

    try {
        /* ── §1: die neue Anfrage ────────────────────────────────────────── */
        const first = await fetch(`${BASE}/osp/webhook`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-OSP-Integration-Key': String(setting.webhookKey).trim() },
            body: JSON.stringify([entry]),
            signal: AbortSignal.timeout(15000),
        });
        console.log('§1  webhook       ->', first.status, await first.text());
        await sleep(600);
        let row = await rowOf();
        show('nach §1', row);
        if (row?.status !== 'LISTED') throw new Error('erwartet LISTED');

        /* ── PATCH: Verkäufer:in wählen → "Verkäufer zugewiesen" ─────────── */
        const assign = await fetch(`${BASE}/osp/documents/${row.id}`, {
            method: 'PATCH', headers: auth,
            body: JSON.stringify({ salespersonId: vendor.id }),
            signal: AbortSignal.timeout(20000),
        });
        console.log('PATCH zuweisen    ->', assign.status);
        if (!assign.ok) throw new Error(await assign.text());
        row = await rowOf();
        show('nach Zuweisung', row);
        if (row?.status !== 'IN_OFFER') throw new Error('erwartet IN_OFFER');
        if (!row?.salespersonProfile?.email) throw new Error('Visitenkarte (§3) fehlt');

        /* ── §1a: dieselbe Anfrage, neu gerechnet ────────────────────────── */
        const revision = await fetch(`${BASE}/osp/webhook/revision`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-OSP-Integration-Key': String(setting.webhookKey).trim() },
            body: JSON.stringify([{ ...entry, changes: ['recalculated'] }]),
            signal: AbortSignal.timeout(15000),
        });
        console.log('§1a revision      ->', revision.status, await revision.text());
        await sleep(600);
        row = await rowOf();
        show('nach §1a', row);
        if (!row?.revisedAt) throw new Error('revisedAt fehlt');
        if (row?.revisionSeenAt) throw new Error('revisionSeenAt hätte geleert sein müssen');
        if (row?.status !== 'IN_OFFER') throw new Error('Stand darf sich durch §1a nicht ändern');

        /* ── Warnung zur Kenntnis nehmen ─────────────────────────────────── */
        const seen = await fetch(`${BASE}/osp/documents/${row.id}/revision-seen`, {
            method: 'POST', headers: auth, signal: AbortSignal.timeout(15000),
        });
        console.log('revision-seen     ->', seen.status);
        if (!seen.ok) throw new Error(await seen.text());
        row = await rowOf();
        show('nach Kenntnisnahme', row);
        if (!row?.revisionSeenAt) throw new Error('revisionSeenAt fehlt');

        /* ── by-tender: ohne Offerte findet es nichts, das ist richtig ───── */
        const byTender = await fetch(`${BASE}/osp/documents/by-tender/gibt-es-nicht`, {
            headers: auth, signal: AbortSignal.timeout(15000),
        });
        const byTenderBody: any = await byTender.json();
        console.log('by-tender (leer)  ->', byTender.status, JSON.stringify(byTenderBody));
        if (byTenderBody.document !== null) throw new Error('erwartet null');

        /* ── PATCH: Verkäufer:in entfernen → zurück auf "Gelistet" ───────── */
        const clear = await fetch(`${BASE}/osp/documents/${row.id}`, {
            method: 'PATCH', headers: auth,
            body: JSON.stringify({ salespersonId: null }),
            signal: AbortSignal.timeout(20000),
        });
        console.log('PATCH entfernen   ->', clear.status);
        if (!clear.ok) throw new Error(await clear.text());
        row = await rowOf();
        show('nach Entfernen', row);
        if (row?.status !== 'LISTED') throw new Error('erwartet LISTED');

        /* ── DELETE: Rückzug (§4b) + Zeile weg ───────────────────────────── */
        const removed = await fetch(`${BASE}/osp/documents/${row.id}`, {
            method: 'DELETE', headers: auth, signal: AbortSignal.timeout(20000),
        });
        const removedBody = await removed.text();
        console.log('DELETE            ->', removed.status, removedBody);
        row = await rowOf();
        console.log('Zeile danach      ->', row ? 'STEHT NOCH' : 'weg');
        // Ohne erreichbare OSP darf die Zeile stehen bleiben — das ist das
        // gewollte Verhalten (die beiden Seiten sollen nie auseinanderlaufen).
        if (row && removed.status !== 502) throw new Error('Zeile hätte weg sein müssen');
        console.log(removed.ok ? '\nOK — die ganze Kette läuft.' : '\nOK — Rückzug bei der OSP scheiterte, Zeile bleibt (gewollt).');
    } finally {
        const leftover = await rowOf();
        if (leftover?.id) {
            await (prisma as any).ospDocument.delete({ where: { id: leftover.id } }).catch(() => undefined);
            console.log('Wegwerf-Zeile aufgeräumt.');
        }
        await (prisma as any).$disconnect();
    }
})().catch((e) => { console.error(e); process.exit(1); });
