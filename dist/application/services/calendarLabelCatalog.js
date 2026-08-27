"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveNewLabelId = exports.roleLabelId = exports.sanitizeLabelId = exports.listLabels = exports.LABEL_ORDER_BY = void 0;
const nanoid_1 = require("nanoid");
const prisma_client_1 = __importDefault(require("../../infrastructure/database/prisma.client"));
const calendarLabels_1 = require("../../shared/calendarLabels");
exports.LABEL_ORDER_BY = [{ sortOrder: 'asc' }, { name: 'asc' }];
const SELECT = { id: true, name: true, color: true, sortOrder: true, role: true, hidden: true };
const read = (tenantId) => prisma_client_1.default.calendarLabel.findMany({ where: { tenantId }, orderBy: exports.LABEL_ORDER_BY, select: SELECT });
/**
 * Die Liste. Ist sie leer, bekommt der Mandant den Erstbestand — je Rolle ein
 * Etikett mit eigener Farbe. Das trifft nur einen NEU angelegten Mandanten:
 * die Migration hat es den bestehenden schon angelegt, und Wegräumen läuft
 * über `hidden` und nicht über Löschen, die Liste fällt also nicht von selbst
 * wieder auf null zurück.
 */
const listLabels = async (tenantId) => {
    const rows = await read(tenantId);
    if (rows.length)
        return rows;
    await prisma_client_1.default.calendarLabel.createMany({
        data: calendarLabels_1.DEFAULT_CALENDAR_LABELS.map((seed) => ({
            id: (0, nanoid_1.nanoid)(12),
            tenantId,
            name: seed.name,
            color: seed.color,
            sortOrder: seed.sortOrder,
            role: seed.role,
            hidden: false,
        })),
        skipDuplicates: true,
    });
    return read(tenantId);
};
exports.listLabels = listLabels;
/**
 * Das Etikett aus einem Anfragekörper.
 *
 *   `undefined` — nicht mitgeschickt: eine Änderung lässt das bestehende
 *                 Etikett stehen.
 *   `null`      — ausdrücklich geleert («ohne Etikett»).
 *   Kennung     — geprüft: sie muss zu DIESEM Mandanten gehören. Ein fremdes
 *                 oder gelöschtes Etikett wird still zu `null`, statt den
 *                 ganzen Speichervorgang an einem Fremdschlüssel scheitern zu
 *                 lassen. Ein AUSGEBLENDETES bleibt erlaubt: es steht schon an
 *                 Einträgen, und ein Speichern soll es dort nicht abreissen.
 */
const sanitizeLabelId = async (tenantId, raw) => {
    if (raw === undefined)
        return undefined;
    const id = String(raw ?? '').trim();
    if (!id)
        return null;
    const found = await prisma_client_1.default.calendarLabel.findFirst({ where: { id, tenantId }, select: { id: true } });
    return found?.id ?? null;
};
exports.sanitizeLabelId = sanitizeLabelId;
/**
 * Das SICHTBARE Etikett einer Rolle. Je Rolle gibt es höchstens eines; ist es
 * ausgeblendet oder gibt es keines, bleibt der Eintrag ohne Etikett.
 */
const roleLabelId = async (tenantId, role) => {
    const found = await prisma_client_1.default.calendarLabel.findFirst({
        where: { tenantId, role, hidden: false },
        orderBy: exports.LABEL_ORDER_BY,
        select: { id: true },
    });
    return found?.id ?? null;
};
exports.roleLabelId = roleLabelId;
/**
 * Das Etikett, mit dem ein NEU angelegter Eintrag startet. Die Oberfläche
 * schickt eines mit; fehlt es (ältere Clients, Anlage aus anderen Modulen),
 * greift der Vorschlag der Rolle. Ausdrückliches `null` bleibt `null` —
 * «ohne Etikett» ist eine Wahl.
 */
const resolveNewLabelId = async (tenantId, raw, role) => {
    const picked = await (0, exports.sanitizeLabelId)(tenantId, raw);
    if (picked !== undefined)
        return picked;
    /* Die Liste muss dafür schon stehen — bei einem frischen Mandanten legt
       `listLabels` sie hier an, sonst bekäme sein erster Termin kein Etikett. */
    await (0, exports.listLabels)(tenantId);
    return (0, exports.roleLabelId)(tenantId, role);
};
exports.resolveNewLabelId = resolveNewLabelId;
//# sourceMappingURL=calendarLabelCatalog.js.map