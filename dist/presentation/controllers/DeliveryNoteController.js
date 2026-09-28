"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DeliveryNoteController = void 0;
const nanoid_1 = require("nanoid");
const prisma_client_1 = __importDefault(require("../../infrastructure/database/prisma.client"));
const documentNumber_1 = require("../../shared/documentNumber");
// Die Modelle DeliveryNote/DeliveryNoteLine sind neu (28.09.2026). ts-node-dev
// behält die Prisma-Typen von seinem Start im Speicher und kennt sie bis zum
// nächsten vollen Neustart nicht — der Zugriff läuft darum untypisiert, wie an
// anderen Stellen dieses Backends (`(prisma as any).salesOrder`).
const db = prisma_client_1.default;
/**
 * ── LIEFERSCHEIN (28.09.2026, Vorgabe Samet) ─────────────────────────────────
 * «Projede nerede gerekiyorsa bu irsaliyeyi uygula»: der Lieferschein gehört
 * zum AUFTRAG (AB) — er sagt, welche Positionen mit welcher Menge an welche
 * Anschrift gingen. Ein Auftrag kann mehrere haben (Teillieferungen).
 *
 * Die Zeilen schlägt die Oberfläche aus den Positionen der Offerte vor (dort
 * liegt die Nummerierung 1 / 1.1, die auch die AB druckt); der Server prüft
 * nur, dass der Auftrag dem Mandanten gehört, und speichert, was bestätigt
 * wurde. Die Nummer LS-YYYY-NNNNN vergibt ausschliesslich der Server, in der
 * Transaktion des Belegs — ein abgebrochener Lieferschein verbrennt keine.
 */
const MAX_LINES = 500;
const TEXT_MAX = 4000;
const SHORT_MAX = 191;
const NOTE_MAX = 2000;
const SITE_KINDS = new Set(['INSTALLATION', 'DELIVERY']);
class InputError extends Error {
}
const cleanText = (value, max) => {
    if (typeof value !== 'string')
        return null;
    const text = value.trim();
    return text ? text.slice(0, max) : null;
};
/** Mengen: nie negativ, auf drei Nachkommastellen (Meter, kg). */
const cleanQty = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0)
        return 0;
    return Math.round(n * 1000) / 1000;
};
/**
 * Ein reines Tagesdatum (JJJJ-MM-TT, wie es das Datumsfeld liefert) wird auf
 * 12:00 UTC gelegt — dann bleibt es in jeder Zeitzone derselbe Kalendertag.
 */
const parseDeliveryDate = (value) => {
    if (value === undefined || value === null || value === '')
        return new Date();
    const raw = String(value).trim();
    const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
    const date = day ? new Date(`${raw}T12:00:00.000Z`) : new Date(raw);
    if (Number.isNaN(date.getTime()))
        throw new InputError('Lieferdatum ungültig.');
    return date;
};
const dayOf = (date) => date ? new Date(date).toISOString().slice(0, 10) : null;
const parseLines = (value) => {
    if (!Array.isArray(value))
        throw new InputError('Positionen fehlen.');
    if (value.length > MAX_LINES)
        throw new InputError(`Höchstens ${MAX_LINES} Positionen.`);
    const rows = [];
    value.forEach((raw, index) => {
        const description = cleanText(raw?.description, TEXT_MAX);
        // Eine Zeile ohne Bezeichnung ist eine leere Eingabezeile — sie
        // gehört nicht auf den Beleg.
        if (!description)
            return;
        rows.push({
            id: (0, nanoid_1.nanoid)(12),
            sourcePositionId: cleanText(raw?.sourcePositionId, SHORT_MAX),
            articleId: cleanText(raw?.articleId, SHORT_MAX),
            positionNumber: cleanText(raw?.positionNumber, 32),
            articleCode: cleanText(raw?.articleCode, SHORT_MAX),
            description,
            unit: cleanText(raw?.unit, SHORT_MAX),
            orderedQty: cleanQty(raw?.orderedQty),
            deliveredQty: cleanQty(raw?.deliveredQty),
            sortOrder: index,
        });
    });
    if (rows.length === 0)
        throw new InputError('Der Lieferschein braucht mindestens eine Position.');
    return rows;
};
/** Genau EINE Zusatzanschrift — die auf der Offerte gewählte, oder keine. */
const parseSite = (kind, address) => {
    const siteKind = typeof kind === 'string' && SITE_KINDS.has(kind) ? kind : null;
    const siteAddress = siteKind ? cleanText(address, TEXT_MAX) : null;
    return { siteAddressKind: siteAddress ? siteKind : null, siteAddress };
};
const serialize = (note, lines) => ({
    id: note.id,
    salesOrderId: note.salesOrderId,
    projectId: note.projectId ?? null,
    noteNumber: note.noteNumber,
    deliveryDate: dayOf(note.deliveryDate),
    customerName: note.customerName ?? null,
    customerAddress: note.customerAddress ?? null,
    siteAddressKind: note.siteAddressKind ?? null,
    siteAddress: note.siteAddress ?? null,
    customerReference: note.customerReference ?? null,
    note: note.note ?? null,
    createdAt: note.createdAt instanceof Date ? note.createdAt.toISOString() : note.createdAt,
    lines: [...lines]
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((line) => ({
        id: line.id,
        sourcePositionId: line.sourcePositionId ?? null,
        articleId: line.articleId ?? null,
        positionNumber: line.positionNumber ?? null,
        articleCode: line.articleCode ?? null,
        description: line.description,
        unit: line.unit ?? null,
        orderedQty: Number(line.orderedQty) || 0,
        deliveredQty: Number(line.deliveredQty) || 0,
    })),
});
const fail = (res, error) => {
    if (error instanceof InputError)
        return res.status(400).json({ error: error.message });
    const message = error?.message || 'Lieferschein konnte nicht gespeichert werden.';
    return res.status(500).json({ error: message });
};
class DeliveryNoteController {
    /** Alle Lieferscheine eines Auftrags, in der Reihenfolge ihrer Entstehung. */
    async list(req, res) {
        try {
            const tenantId = req.user.tenantId;
            const salesOrderId = String(req.query.salesOrderId || '').trim();
            if (!salesOrderId)
                return res.status(400).json({ error: 'Auftrag fehlt.' });
            const notes = await db.deliveryNote.findMany({
                where: { tenantId, salesOrderId },
                include: { lines: true },
                orderBy: [{ createdAt: 'asc' }, { noteNumber: 'asc' }],
            });
            res.json({ notes: notes.map((note) => serialize(note, note.lines)) });
        }
        catch (error) {
            fail(res, error);
        }
    }
    /**
     * Artikelnummern zu den Artikeln der Offertpositionen — die Positionen
     * selbst tragen nur die Artikel-Id, der Lieferschein druckt die Nummer.
     * Höchstens 500 Ids, nur Artikel des eigenen Mandanten.
     */
    async articleCodes(req, res) {
        try {
            const tenantId = req.user.tenantId;
            const ids = String(req.query.ids || '')
                .split(',')
                .map((id) => id.trim())
                .filter(Boolean)
                .slice(0, 500);
            if (ids.length === 0)
                return res.json({ codes: {} });
            const rows = await db.article.findMany({
                where: { tenantId, id: { in: ids } },
                select: { id: true, articleCode: true },
            });
            const codes = {};
            rows.forEach((row) => { if (row.articleCode)
                codes[row.id] = row.articleCode; });
            res.json({ codes });
        }
        catch (error) {
            fail(res, error);
        }
    }
    /**
     * Die Nummer, die der NÄCHSTE Lieferschein bekäme — nur eine Vorschau für
     * die Erfassungsmaske, keine Reservierung (vergeben wird beim Erstellen).
     */
    async nextNumber(req, res) {
        try {
            const number = await (0, documentNumber_1.peekDocumentNumber)(req.user.tenantId, 'DELIVERY_NOTE');
            res.json({ number });
        }
        catch (error) {
            fail(res, error);
        }
    }
    async create(req, res) {
        try {
            const tenantId = req.user.tenantId;
            const body = req.body ?? {};
            const salesOrderId = cleanText(body.salesOrderId, SHORT_MAX);
            if (!salesOrderId)
                return res.status(400).json({ error: 'Auftrag fehlt.' });
            const order = await db.salesOrder.findFirst({
                where: { id: salesOrderId, tenantId },
                select: { id: true, projectId: true, cancelledAt: true },
            });
            if (!order)
                return res.status(404).json({ error: 'Auftrag nicht gefunden.' });
            // Ein stornierter Auftrag liefert nichts mehr aus (06.09.2026).
            if (order.cancelledAt) {
                return res.status(400).json({ error: 'Ein stornierter Auftrag bekommt keinen Lieferschein.' });
            }
            const lines = parseLines(body.lines);
            const deliveryDate = parseDeliveryDate(body.deliveryDate);
            const site = parseSite(body.siteAddressKind, body.siteAddress);
            const data = {
                tenantId,
                salesOrderId: order.id,
                projectId: order.projectId ?? null,
                deliveryDate,
                customerName: cleanText(body.customerName, SHORT_MAX),
                customerAddress: cleanText(body.customerAddress, TEXT_MAX),
                ...site,
                customerReference: cleanText(body.customerReference, SHORT_MAX),
                note: cleanText(body.note, NOTE_MAX),
                createdByEmployeeId: req.user.id,
            };
            const id = (0, nanoid_1.nanoid)(12);
            const created = await prisma_client_1.default.$transaction(async (client) => {
                const tx = client;
                const noteNumber = await (0, documentNumber_1.nextDocumentNumber)(tenantId, 'DELIVERY_NOTE', tx);
                const note = await tx.deliveryNote.create({ data: { id, noteNumber, ...data } });
                await tx.deliveryNoteLine.createMany({
                    data: lines.map((line) => ({ ...line, deliveryNoteId: id })),
                });
                return note;
            });
            res.status(201).json(serialize(created, lines));
        }
        catch (error) {
            fail(res, error);
        }
    }
    /** Kopf und Zeilen ersetzen — die Nummer bleibt, was sie war. */
    async update(req, res) {
        try {
            const tenantId = req.user.tenantId;
            const id = String(req.params.id);
            const body = req.body ?? {};
            const existing = await db.deliveryNote.findFirst({ where: { id, tenantId }, select: { id: true } });
            if (!existing)
                return res.status(404).json({ error: 'Lieferschein nicht gefunden.' });
            const data = {};
            if ('deliveryDate' in body)
                data.deliveryDate = parseDeliveryDate(body.deliveryDate);
            if ('customerName' in body)
                data.customerName = cleanText(body.customerName, SHORT_MAX);
            if ('customerAddress' in body)
                data.customerAddress = cleanText(body.customerAddress, TEXT_MAX);
            if ('siteAddressKind' in body || 'siteAddress' in body) {
                Object.assign(data, parseSite(body.siteAddressKind, body.siteAddress));
            }
            if ('customerReference' in body)
                data.customerReference = cleanText(body.customerReference, SHORT_MAX);
            if ('note' in body)
                data.note = cleanText(body.note, NOTE_MAX);
            const lines = 'lines' in body ? parseLines(body.lines) : null;
            const saved = await prisma_client_1.default.$transaction(async (client) => {
                const tx = client;
                const note = await tx.deliveryNote.update({ where: { id }, data });
                if (lines) {
                    await tx.deliveryNoteLine.deleteMany({ where: { deliveryNoteId: id } });
                    await tx.deliveryNoteLine.createMany({
                        data: lines.map((line) => ({ ...line, deliveryNoteId: id })),
                    });
                }
                const storedLines = lines ?? await tx.deliveryNoteLine.findMany({ where: { deliveryNoteId: id } });
                return { note, lines: storedLines };
            });
            res.json(serialize(saved.note, saved.lines));
        }
        catch (error) {
            fail(res, error);
        }
    }
    async remove(req, res) {
        try {
            const tenantId = req.user.tenantId;
            const id = String(req.params.id);
            // Die Zeilen gehen über ON DELETE CASCADE mit.
            const result = await db.deliveryNote.deleteMany({ where: { id, tenantId } });
            if (result.count === 0)
                return res.status(404).json({ error: 'Lieferschein nicht gefunden.' });
            res.json({ message: 'Lieferschein gelöscht.' });
        }
        catch (error) {
            fail(res, error);
        }
    }
}
exports.DeliveryNoteController = DeliveryNoteController;
//# sourceMappingURL=DeliveryNoteController.js.map