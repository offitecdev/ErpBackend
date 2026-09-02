import { Router } from 'express';
import crypto from 'crypto';
import { nanoid } from 'nanoid';
import prisma from '../../infrastructure/database/prisma.client';
import { requireAuth } from '../middlewares/AuthMiddleware';
import { requireAnyPermission, requirePermission } from '../middlewares/RbacMiddleware';
import { findTenantRootIdCached, getAllTenants, collectDescendantIds } from '../../shared/tenantTree';
import { getPersonnelTenantScope, employeeScopeWhere } from '../controllers/serviceTenantScope';
import { nextDocumentNumber } from '../../shared/documentNumber';
import { formatCustomerAddress } from '../../application/utils/customerAddress';
import {
    OSP_ENUM_TO_INTERNAL,
    OSP_STATUS_RANK,
    OSP_WIRE_STATUS,
    fetchOspOfferStatus,
    withdrawOspOfferStatus,
    type OspSalesmanDto,
    type OspStatusRow,
} from '../../infrastructure/services/OspClient';
import {
    fetchOspDatasheet,
    mergeSpecs,
    pickDatasheetUrl,
    specsFromOfferEntry,
    type OspDatasheetSpecs,
} from '../../infrastructure/services/ospDatasheet';
import { ospDatasheetStorage } from '../../infrastructure/services/LocalFileStorage';
import { reportOspDocumentStatus } from '../../infrastructure/services/ospStatusSync';

/**
 * ── OSP-MODUL (Offitec Selection Platform, 04.09.2026) ──────────────────────
 * Eingehender Webhook der OSP-Offertanfragen, die Belegliste der OSP-Seite
 * (/sales/osp), Statuspflege mit Rückmeldung an die OSP und der Offerten-
 * Import ("Offerte aus OSP erzeugen").
 *
 * Grundsätze:
 *  • Der Feed hängt am WURZEL-Mandanten; welche Mandanten ihn sehen, sagt
 *    `OspSetting.tenantIds` (Einstellungen → Module → Verkauf → OSP).
 *  • OSP-Zeilen legen NIEMALS Artikel oder Bestand an — der Import erzeugt
 *    eine Offerte mit reinen Textpositionen (rowType CUSTOM), nur für diese
 *    eine Offerte.
 *  • Der Kunde des Imports darf ein CRM-Kunde sein ODER von Hand eingegeben
 *    werden (Tender.manualCustomer*) — von Hand heisst: NIRGENDS registriert.
 *  • Zuständig ist EINE Person: die Verkäuferin/der Verkäufer. Ihre Wahl ist
 *    zugleich der Bearbeitungsstand — LISTED ohne, IN_OFFER mit (drüben
 *    "under review"). Der Stand wird nirgends von Hand gesetzt.
 *  • Jede Meldung an die OSP ist Best-Effort; Ausgang + Fehler stehen an der
 *    Zeile (lastReport*).
 */

const router = Router();

/** WITHDRAWN steht neben der Reihe: die anfragende Person hat zurückgezogen. */
const OSP_STATUSES = ['LISTED', 'IN_OFFER', 'SENT', 'APPROVED', 'WITHDRAWN'] as const;
type OspStatus = (typeof OSP_STATUSES)[number];

const SETTINGS_MANAGE = ['tenders.manage', 'roles.manage', 'tenants.update'];

/** Standard-Seitengrösse der Liste — "in Gruppen von 15 ziehen" (Vorgabe). */
const PAGE_SIZE = 15;

/**
 * Die Adressen, die der OSP für die VIER eingehenden Aufrufe zu nennen sind
 * (§1, §1a, §1b, §1c). Vier statt einer, damit drüben auf die ADRESSE geroutet
 * werden kann und nicht aus dem Körper geraten werden muss, welcher Fall
 * vorliegt. Die ersten drei sind Anfragen einer Person; die vierte ist der
 * Aktivitätsstrom und ausdrücklich KEINE.
 *
 * Solange eine Adresse drüben nicht eingetragen ist, wird der Aufruf gar nicht
 * erst gemacht — die OSP überrascht uns mit keinem Verkehr, um den wir nicht
 * gebeten haben. `changeWebhookPath` ist die Adresse der zweiten
 * Vertragsfassung und bleibt stehen, solange sie drüben noch eingetragen ist.
 */
const OSP_WEBHOOK_PATHS = {
    webhookPath: '/backend/api/v1/osp/webhook',
    revisionWebhookPath: '/backend/api/v1/osp/webhook/revision',
    withdrawalWebhookPath: '/backend/api/v1/osp/webhook/withdrawal',
    projectWebhookPath: '/backend/api/v1/osp/webhook/project',
    changeWebhookPath: '/backend/api/v1/osp/webhook/change',
} as const;

/* ── kleine Helfer ──────────────────────────────────────────────────────── */

const asTrimmed = (value: unknown): string | null => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
};

/** Schlüsselvergleich in konstanter Zeit — es ist eine Authentifizierung. */
const keysMatch = (a: string, b: string): boolean => {
    const left = Buffer.from(a, 'utf8');
    const right = Buffer.from(b, 'utf8');
    if (left.length !== right.length) return false;
    return crypto.timingSafeEqual(left, right);
};

/**
 * "4820193-57" → { projectNumber: "4820193", documentId: "57" }; eine nackte
 * "4820193" bleibt, wie sie ist. Die zusammengesetzte Form erzeugt die OSP
 * nicht mehr (§0) — sie kommt nur noch aus älteren Zeilen und aus einer OSP,
 * die noch auf der dritten Vertragsfassung steht.
 */
const parseReference = (reference: string): { projectNumber: string; documentId: string | null } => {
    const splitAt = reference.lastIndexOf('-');
    if (splitAt <= 0) return { projectNumber: reference, documentId: null };
    return { projectNumber: reference.slice(0, splitAt), documentId: reference.slice(splitAt + 1) };
};

const parseTenantIds = (value: unknown): string[] => {
    if (Array.isArray(value)) return value.map(String).filter(Boolean);
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
        } catch { return []; }
    }
    return [];
};

interface FeedContext {
    rootId: string;
    setting: any | null;
    /** Darf der AKTUELLE Mandant den Feed sehen? (Wurzel immer, sonst Auswahl.) */
    visible: boolean;
}

/** Wurzel + Einstellungen + Sichtbarkeit für den angemeldeten Mandanten. */
const loadFeedContext = async (tenantId: string): Promise<FeedContext | null> => {
    const rootId = await findTenantRootIdCached(tenantId);
    if (!rootId) return null;
    const setting = await (prisma as any).ospSetting.findUnique({ where: { tenantId: rootId } });
    const selected = parseTenantIds(setting?.tenantIds);
    const visible = tenantId === rootId || selected.includes(tenantId);
    return { rootId, setting, visible };
};

/** Die abzulegende Visitenkarte einer gewählten Person (§3-Form). */
const salesmanProfileOf = (employee: {
    firstName?: string | null; lastName?: string | null; email?: string | null; phone?: string | null;
}): OspSalesmanDto => ({
    email: employee.email || null,
    name: employee.firstName || null,
    surname: employee.lastName || null,
    phone: employee.phone || null,
});

/**
 * Das Datenblatt einer EINHEIT holen, ablegen und auslesen — Best-Effort,
 * wirft nie. Erfolg wie Misserfolg stehen danach an der Einheit (datasheet*),
 * genau wie bei den Statusmeldungen: die Verkaufsseite sieht, WARUM nichts da
 * ist.
 *
 * Geholt wird, weil die Adresse drüben NICHT bleibt: jede Neuberechnung, jede
 * Umbenennung des Projekts rendert neu und löscht die alte Datei (§1c). Was
 * einmal bei uns liegt, bleibt.
 */
const storeUnitDatasheet = async (
    setting: any | null,
    unitId: string,
    url: string,
    // Die Angaben, die §1 zu DIESER Lieferung selbst mitgeschickt hat. Sie
    // gelten vor dem, was im PDF steht (dieselbe Momentaufnahme, aber ohne
    // Umweg über den Fliesstext); das PDF füllt nur noch auf, was der Vertrag
    // nicht kennt — vor allem das Medium.
    webhookSpecs?: OspDatasheetSpecs | null,
): Promise<void> => {
    if (!setting) return;
    const previous = await (prisma as any).ospUnit.findUnique({
        where: { id: unitId },
        select: { datasheetFile: true, datasheetSpecs: true },
    }).catch(() => null);

    const result = await fetchOspDatasheet(setting, setting.tenantId, url);
    const specs = mergeSpecs(
        mergeSpecs(previous?.datasheetSpecs as OspDatasheetSpecs, result.specs),
        webhookSpecs,
    );
    await (prisma as any).ospUnit.update({
        where: { id: unitId },
        data: result.ok
            ? {
                datasheetFile: result.file ?? null,
                datasheetSpecs: (Object.keys(specs).length ? specs : null) as any,
                datasheetFetchedAt: new Date(),
                // Ein unlesbares, aber abgelegtes PDF behält seinen Hinweis.
                datasheetError: result.error ?? null,
            }
            : { datasheetError: result.error || 'Datenblatt konnte nicht geholt werden.' },
    }).catch(() => undefined);

    // Die alte Datei erst entfernen, wenn die neue sicher an der Einheit steht.
    const old = previous?.datasheetFile;
    if (result.ok && old && old !== result.file) {
        await ospDatasheetStorage.remove(old).catch(() => undefined);
    }
};

/**
 * Der Stand FOLGT der Arbeit, er wird nicht gewählt (Vertrag, "Required
 * workflow in the sales system"):
 *
 *  • niemand zuständig            → LISTED   (drüben "created", "Gelistet")
 *  • Verkäufer:in gewählt         → IN_OFFER (drüben "under review",
 *                                             bei uns "Verkäufer zugewiesen")
 *  • Angebotsmail hinaus          → SENT     (drüben "offer has been sent")
 *
 * SENT und APPROVED bleiben stehen: eine hinausgegangene Offerte fällt nicht
 * zurück, bloss weil jemand die Zuständigkeit tauscht. WITHDRAWN ebenso — die
 * OSP hat ihre Seite dort bereits abgeräumt.
 */
const statusForAssignment = (current: string, hasSalesperson: boolean): string => {
    if (current === 'SENT' || current === 'APPROVED' || current === 'WITHDRAWN') return current;
    return hasSalesperson ? 'IN_OFFER' : 'LISTED';
};

const employeeDisplayName = (employee: { firstName?: string | null; lastName?: string | null; email?: string | null }): string =>
    [employee.firstName, employee.lastName].filter(Boolean).join(' ').trim() || employee.email || '';

/** Leere Felder raus — was die OSP nicht nennt, darf nichts überschreiben. */
const withoutEmpty = <T extends Record<string, unknown>>(row: T): Partial<T> => {
    const kept: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
        if (value === null || value === undefined || value === '') continue;
        kept[key] = value;
    }
    return kept as Partial<T>;
};

/* ── 1) Eingehende Webhooks (OHNE JWT — gemeinsamer Schlüssel) ───────────── */

/**
 * Den Schlüssel des eingehenden Aufrufs prüfen und die dazugehörige Firma
 * heraussuchen. Alle drei Webhooks (§1, §1a, §1b) hängen am SELBEN Schlüssel —
 * getrennt sind nur die Adressen, damit die OSP nicht aus dem Körper raten
 * muss, welcher der drei Fälle vorliegt.
 *
 * Ist nirgends ein Schlüssel hinterlegt, wird alles abgelehnt (503) — genau
 * wie die OSP es umgekehrt hält: NIE offen durchfallen.
 */
const authenticateWebhook = async (req: any, res: any): Promise<any | null> => {
    const key = asTrimmed(req.header('x-osp-integration-key'));
    const settings = await (prisma as any).ospSetting.findMany({ where: { NOT: { webhookKey: null } } });
    const armed = settings.filter((row: any) => asTrimmed(row.webhookKey));
    if (!armed.length) {
        res.status(503).json({ message: 'OSP integration key is not configured.' });
        return null;
    }
    const setting = key ? armed.find((row: any) => keysMatch(asTrimmed(row.webhookKey) || '', key)) : null;
    if (!setting) {
        res.status(401).json({ message: 'Missing or wrong X-OSP-Integration-Key.' });
        return null;
    }
    return setting;
};

interface IngestResult {
    /** Wie viele PROJEKTE der Aufruf beschrieben hat (§1/§1a: immer eines). */
    received: number;
    created: number;
    updated: number;
    /** Wie viele Einheiten dabei angelegt bzw. aufgefrischt wurden. */
    units: number;
    /** Nach der Quittung zu erledigen — die OSP wartet auf keine Datei. */
    datasheetJobs: Array<{ unitId: string; url: string; specs: OspDatasheetSpecs }>;
    /**
     * Zeilen, deren Stand der OSP zu quittieren ist — mit dem Stand, der zu
     * melden ist. Neuzugänge quittieren "created"; eine Überarbeitung meldet
     * die Zeile wieder auf "under review", weil die OSP drüben selbst auf
     * "created" zurückgesetzt hat, die Zuständigkeit hier aber bestehen bleibt
     * (§1a, "The sales system must ensure OSP is back in `under review`").
     */
    report: Array<{ id: string; status: string }>;
}

/* ── Der Körper einer Anfrage, auf EINE Form gebracht ────────────────────────
   Seit der vierten Vertragsfassung ist der Körper von §1 und §1a EIN OBJEKT je
   Projekt, und die angefragten Einheiten hängen als `projectDetails` darunter.
   Vorher war es eine Liste, in der jede Einheit das Projekt noch einmal
   wiederholte und ihre Referenz "4820193-57" hiess.

   Beides landet hier auf derselben Form: ein Projekt mit seinen Einheiten. So
   bleibt eine OSP, die noch auf der dritten Fassung steht, verstanden — und es
   gibt trotzdem nur EINEN Weg durch das Einlesen. */

interface OfferUnitPayload {
    /** Die eigene Dokument-Id der OSP — ohne Projektteil (§0). */
    ospDocumentId: string;
    pdfUrl: string | null;
    /** §1a: was an dieser Einheit passiert ist. `[]` ist eine Aussage. */
    changes: string[] | null;
    specs: OspDatasheetSpecs;
    raw: any;
}

interface OfferProjectPayload {
    /** Die Projektnummer — der Schlüssel jeder Statusmeldung (§0). */
    reference: string;
    /** Die Dokument-Id, falls der Körper noch die alte Form hatte. */
    legacyDocumentId: string | null;
    ospProjectId: number | null;
    /** §1a: was am PROJEKT selbst bewegt wurde. */
    changes: string[] | null;
    units: OfferUnitPayload[];
    /**
     * Nennt der Körper die Einheiten des Projekts als Liste? Nur dann ist die
     * Liste vollständig genug, um daraus zu schliessen, dass eine nicht
     * genannte Einheit weg ist — in der alten Form beschrieb jeder Eintrag nur
     * SICH, und andere Einheiten desselben Projekts standen daneben.
     */
    hasUnitList: boolean;
    raw: any;
}

/** Eine Nummer der OSP als Zeichenkette — `projectNumber` kommt als ZAHL. */
const asKey = (value: unknown): string | null => {
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return asTrimmed(value);
};

const asDate = (value: unknown): Date | null => {
    const text = asTrimmed(value);
    if (!text || Number.isNaN(Date.parse(text))) return null;
    return new Date(text);
};

/**
 * Eine `changes`-Liste. Die LEERE Liste bleibt erhalten, sie ist eine Aussage
 * ("neu gerendert durch eine Änderung am Projekt, an der Einheit selbst nichts
 * bewegt" — §1a). Unbekannte Einträge bleiben stehen: der Vertrag nennt die
 * Liste ausdrücklich eine Beschreibung und keinen geschlossenen Wortschatz.
 */
const asChangeList = (value: unknown): string[] | null => {
    if (!Array.isArray(value)) return null;
    return value.map((entry) => asTrimmed(entry)).filter(Boolean) as string[];
};

const normalizeOfferPayload = (body: unknown): OfferProjectPayload[] => {
    const rows = Array.isArray(body) ? body : (body ? [body] : []);
    const out: OfferProjectPayload[] = [];

    for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        const entry = row as Record<string, any>;
        const key = asKey(entry.projectNumber);
        if (!key) continue;
        const { projectNumber, documentId } = parseReference(key);
        const ospProjectId = Number.isFinite(Number(entry.projectId)) && entry.projectId !== null
            ? Number(entry.projectId)
            : null;

        const details = Array.isArray(entry.projectDetails) ? entry.projectDetails : null;
        const units: OfferUnitPayload[] = details
            ? details
                .filter((detail: any) => detail && typeof detail === 'object')
                .map((detail: any) => ({
                    ospDocumentId: asKey(detail.id) || '',
                    pdfUrl: pickDatasheetUrl(detail),
                    changes: asChangeList(detail.changes),
                    specs: specsFromOfferEntry(detail),
                    raw: detail,
                }))
                .filter((unit: OfferUnitPayload) => unit.ospDocumentId)
            : (documentId
                // Die alte Form: der Eintrag IST die Einheit, und seine
                // Dokument-Id steckt in der zusammengesetzten Referenz.
                ? [{
                    ospDocumentId: documentId,
                    pdfUrl: pickDatasheetUrl(entry),
                    changes: asChangeList(entry.changes),
                    specs: specsFromOfferEntry(entry),
                    raw: entry,
                }]
                : []);

        out.push({
            reference: projectNumber,
            legacyDocumentId: details ? null : documentId,
            ospProjectId,
            // In der ALTEN Form beschrieb `changes` den einen Beleg, nicht das
            // Projekt (siehe offer-change-tracking.md) — dort gehört die Liste
            // also an die Einheit und NUR dorthin, sonst stünde derselbe Satz
            // zweimal auf der Seite.
            changes: details ? asChangeList(entry.changes) : null,
            units,
            hasUnitList: Boolean(details),
            raw: entry,
        });
    }
    return out;
};

/**
 * Die Anfragezeile eines Projekts finden — und ältere Zeilen dabei einsammeln.
 *
 * Bis zur dritten Vertragsfassung trug jede Einheit ihre eigene Zeile mit der
 * Referenz "4820193-57". Seit der vierten ist die Anfrage das PROJEKT, und die
 * Referenz ist die nackte Projektnummer. Eine Anfrage zu einem Projekt, von dem
 * wir nur noch die alten Zeilen haben, darf deshalb keine zweite Zeile daneben
 * anlegen: die vorhandene wird auf das Projekt umbenannt und behält damit
 * Offerte, Zuständigkeit und Verlauf.
 *
 * Welche, wenn es mehrere sind? Die, an der die ARBEIT hängt: zuerst die mit
 * einer Offerte, dann die im weitesten Stand, zuletzt die älteste. Genau
 * dieselbe Wahl trifft die Migration `20260920090000_osp_contract_v4`.
 */
const findRequestRow = async (tenantId: string, projectNumber: string): Promise<any | null> => {
    const exact = await (prisma as any).ospDocument.findUnique({
        where: { tenantId_reference: { tenantId, reference: projectNumber } },
    });
    if (exact) return exact;

    const legacy = await (prisma as any).ospDocument.findMany({
        where: { tenantId, projectNumber },
        orderBy: { createdAt: 'asc' },
    });
    if (!legacy.length) return null;

    const rank = (row: any): number => (OSP_STATUS_RANK[row.status] ?? -1);
    const primary = [...legacy].sort((a, b) => {
        if (Boolean(a.tenderId) !== Boolean(b.tenderId)) return a.tenderId ? -1 : 1;
        if (rank(a) !== rank(b)) return rank(b) - rank(a);
        return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    })[0];

    return (prisma as any).ospDocument.update({
        where: { id: primary.id },
        data: { reference: projectNumber },
    });
};

/**
 * Der gemeinsame Weg von §1 und §1a: EIN Projekt, seine Einheiten darunter.
 * Die beiden Fassungen sind Feld für Feld gleich und unterscheiden sich nur
 * darin, was sie bedeuten — deshalb EINE Auswertung mit einem Schalter:
 *
 *  • `NEW` (§1)       — eine Anfrage, die wir noch nie gesehen haben. Sie nennt
 *                       JEDE Einheit des Projekts, die ein Datenblatt hat, und
 *                       wird der OSP mit "created" quittiert.
 *  • `REVISION` (§1a) — dieselbe Anfrage, geändert. Sie ist ein NACHTRAG, keine
 *                       Neufassung: genannt wird nur, was sich bewegt hat, und
 *                       `projectDetails` darf leer sein (dann hat die anfragende
 *                       Person bloss Kontakt- oder Lieferangaben berichtigt).
 *                       Die OSP hat drüben bereits selbst auf "created"
 *                       zurückgesetzt, die Zuständigkeit bleibt aber hier —
 *                       also wird sie zurück auf "under review" gemeldet.
 *
 * Was die OSP nicht mitschickt, überschreibt nichts: eine spätere Lieferung
 * darf nicht löschen, was eine frühere gebracht hat.
 */
const ingestOfferProjects = async (
    setting: any,
    projects: OfferProjectPayload[],
    mode: 'NEW' | 'REVISION',
): Promise<IngestResult> => {
    const out: IngestResult = {
        received: projects.length, created: 0, updated: 0, units: 0,
        datasheetJobs: [], report: [],
    };

    for (const project of projects) {
        const entry = project.raw as Record<string, any>;

        /* Die beschreibenden Felder. `companyName` und `projectAddress` sind
           die Namen der dritten Vertragsfassung; die alten bleiben als
           Rückfall stehen, weil ältere Zeilen und die Zusatzfelder der OSP sie
           noch führen. Die Adressen beschreiben den AUFTRAG, nicht das Konto:
           wo die anfragende Person "gleich wie Projekt" gewählt hat, wiederholt
           die OSP die Projektadresse bereits aufgelöst (§1). */
        const descriptive = withoutEmpty({
            projectNumber: project.reference,
            documentId: project.legacyDocumentId,
            ospProjectId: project.ospProjectId,
            projectName: asTrimmed(entry.projectName),
            requesterFirstName: asTrimmed(entry.username),
            requesterLastName: asTrimmed(entry.surname),
            requesterEmail: asTrimmed(entry.email),
            phone: asTrimmed(entry.phone),
            company: asTrimmed(entry.companyName) || asTrimmed(entry.company),
            country: asTrimmed(entry.country),
            city: asTrimmed(entry.city),
            address: asTrimmed(entry.projectAddress) || asTrimmed(entry.address),
            shippingAddress: asTrimmed(entry.shippingAddress),
            billingAddress: asTrimmed(entry.billingAddress),
            postalCode: asTrimmed(entry.postalCode),
            userType: asTrimmed(entry.userType),
            category: asTrimmed(entry.category),
            unitType: asTrimmed(entry.type),
            model: asTrimmed(entry.model),
            ospCreatedAt: asDate(entry.created_at) || asDate(entry.createdAt),
        });
        // Der unveränderte Eintrag geht IMMER mit — ohne ihn ist hinterher
        // nicht mehr feststellbar, was tatsächlich geliefert wurde.
        const data: any = { ...descriptive, rawPayload: entry as any };

        const existing = await findRequestRow(setting.tenantId, project.reference);
        let row: any;

        if (existing) {
            /** Eine Zeile, die nach einem Rückzug wieder auflebt (§1b → §1). */
            let revived = false;
            /** Eine Überarbeitung, die drüben wieder auf "under review" gehört. */
            let revisionReport = false;

            if (mode === 'REVISION') {
                // Sichtbar machen, dass sich etwas geändert hat. Der
                // Bearbeitungsstand bleibt: die Offerte, die vielleicht schon
                // besteht, gehört weiterhin zu diesem Projekt.
                data.revisedAt = new Date();
                data.revisionCount = { increment: 1 };
                // Eine zur Kenntnis genommene frühere Überarbeitung deckt diese
                // hier nicht mit ab — die Warnung an der Offerte lebt auf.
                data.revisionSeenAt = null;
                // Was am PROJEKT bewegt wurde, steht an der Zeile: genau diese
                // Liste hat die anfragende Person drüben auch zu sehen bekommen.
                if (project.changes) data.changes = project.changes as any;
                // Drüben steht die Anfrage nach der Überarbeitung wieder auf
                // "created", die Zuständigkeit hier besteht aber fort. Also
                // wird sie zurück auf "under review" gesetzt (§1a).
                if (existing.salespersonEmail && existing.status === 'IN_OFFER') {
                    revisionReport = true;
                }
            } else if (existing.status === 'WITHDRAWN') {
                // Nach einem Rückzug darf neu angefragt werden — das kommt als
                // NEUE Anfrage (§1), nicht als Überarbeitung. Die Zeile lebt
                // damit wieder auf, mitsamt Offerte und Zuständigkeit.
                data.status = 'LISTED';
                data.withdrawnAt = null;
                data.withdrawnByName = null;
                data.withdrawnByEmail = null;
                data.withdrawnFromStatus = null;
                // Eine frische Anfrage trägt keine Änderungsliste (§1).
                data.changes = null as any;
                // Drüben ist es eine frische Anfrage, also wird sie auch wie
                // eine quittiert — nach dem Rückzug steht dort gar kein Stand
                // mehr, den unsere Meldung überschreiben könnte.
                revived = true;
            } else {
                data.changes = null as any;
            }

            row = await (prisma as any).ospDocument.update({ where: { id: existing.id }, data });
            out.updated += 1;
            if (revived) out.report.push({ id: existing.id, status: 'LISTED' });
            else if (revisionReport) out.report.push({ id: existing.id, status: 'IN_OFFER' });
        } else {
            row = await (prisma as any).ospDocument.create({
                data: {
                    id: nanoid(12), tenantId: setting.tenantId, reference: project.reference,
                    status: 'LISTED', ...data,
                    ...(mode === 'REVISION' && project.changes ? { changes: project.changes as any } : {}),
                },
            });
            out.created += 1;
            // Auch eine Überarbeitung zu einem Projekt, das wir nie bekommen
            // haben, wird angelegt und quittiert: lieber eine Anfrage zu viel
            // in der Liste als eine, die niemand je sieht — die OSP wiederholt
            // nicht.
            out.report.push({ id: row.id, status: 'LISTED' });
        }

        const jobs = await ingestUnits(setting, row, project, mode);
        out.units += jobs.touched;
        out.datasheetJobs.push(...jobs.datasheetJobs);
    }

    return out;
};

/**
 * Die angefragten Einheiten eines Projekts einlesen.
 *
 * Eine neue Anfrage (§1) nennt JEDE Einheit des Projekts, die ein Datenblatt
 * hat — sie ist damit vollständig, und was sie nicht nennt, gehört nicht mehr
 * dazu. Eine Überarbeitung (§1a) nennt nur die GEÄNDERTEN; eine gelöschte
 * Einheit meldet die OSP ausdrücklich NICHT ("reconcile against the ids you
 * receive"), also wird an einer Überarbeitung nichts weggeräumt.
 */
const ingestUnits = async (
    setting: any,
    row: any,
    project: OfferProjectPayload,
    mode: 'NEW' | 'REVISION',
): Promise<{ touched: number; datasheetJobs: IngestResult['datasheetJobs'] }> => {
    const datasheetJobs: IngestResult['datasheetJobs'] = [];
    let touched = 0;

    for (const unit of project.units) {
        const existing = await (prisma as any).ospUnit.findUnique({
            where: { requestId_ospDocumentId: { requestId: row.id, ospDocumentId: unit.ospDocumentId } },
        });

        // Die berechneten Angaben stehen seit der dritten Vertragsfassung im
        // Webhook selbst (§1 "The calculated unit") — abgelesen aus derselben
        // Momentaufnahme, aus der das PDF gerendert wurde. Sie gelten damit vor
        // dem, was aus dem PDF-Text zu lesen wäre; auf das PDF wartet niemand.
        const specs = mergeSpecs(existing?.datasheetSpecs as OspDatasheetSpecs, unit.specs);
        const data: any = {
            datasheetSpecs: (Object.keys(specs).length ? specs : null) as any,
            changes: (unit.changes ?? null) as any,
            receivedAt: new Date(),
            rawPayload: unit.raw as any,
        };
        if (unit.pdfUrl) data.pdfUrl = unit.pdfUrl;

        let saved: any;
        if (existing) {
            saved = await (prisma as any).ospUnit.update({ where: { id: existing.id }, data });
        } else {
            // §1 nennt Name und Modell der Einheit nicht — der Aktivitätsstrom
            // (§1c) schon. Kennt er den Beleg bereits, trägt die Position
            // sofort ihren richtigen Titel statt bloss den Projektnamen.
            const known = await (prisma as any).ospFeedEntry.findUnique({
                where: { tenantId_ospDocumentId: { tenantId: setting.tenantId, ospDocumentId: unit.ospDocumentId } },
                select: { unitName: true, unitModel: true },
            }).catch(() => null);
            saved = await (prisma as any).ospUnit.create({
                data: {
                    id: nanoid(12),
                    tenantId: setting.tenantId,
                    requestId: row.id,
                    ospDocumentId: unit.ospDocumentId,
                    unitName: known?.unitName || null,
                    unitModel: known?.unitModel || null,
                    ...data,
                },
            });
        }
        touched += 1;

        // Erneut geholt wird nur, wenn das Datenblatt fehlt oder die OSP auf
        // eine ANDERE Datei zeigt — sonst bliebe es bei jeder Wiederholung
        // derselben Anfrage beim Herunterladen.
        if (saved?.pdfUrl && (!saved.datasheetFile || existing?.pdfUrl !== saved.pdfUrl)) {
            datasheetJobs.push({ unitId: saved.id, url: saved.pdfUrl, specs: unit.specs });
        }
    }

    /* Eine NEUE Anfrage ist vollständig: was sie nicht nennt, gehört nicht
       (mehr) zum Projekt. Bei einer Überarbeitung gilt das ausdrücklich nicht —
       sie schickt nur, was sich geändert hat. */
    if (mode === 'NEW' && project.hasUnitList && project.units.length) {
        const keep = project.units.map((unit) => unit.ospDocumentId);
        const stale = await (prisma as any).ospUnit.findMany({
            where: { requestId: row.id, ospDocumentId: { notIn: keep } },
            select: { id: true, datasheetFile: true },
        });
        if (stale.length) {
            await (prisma as any).ospUnit.deleteMany({ where: { id: { in: stale.map((unit: any) => unit.id) } } });
            for (const unit of stale) {
                if (unit.datasheetFile) await ospDatasheetStorage.remove(unit.datasheetFile).catch(() => undefined);
            }
        }
    }

    return { touched, datasheetJobs };
};

/** Quittieren, dann in Ruhe arbeiten — die OSP wartet auf keine Datei. */
const finishIngest = (setting: any, res: any, result: IngestResult): void => {
    res.status(200).json({
        received: result.received,
        created: result.created,
        updated: result.updated,
        units: result.units,
        datasheets: result.datasheetJobs.length,
    });
    for (const row of result.report) {
        // Gemeldet wird die Zeile, wie sie nach dem Einlesen dasteht: die
        // Visitenkarte gehört zur Meldung (§3), und bei einer Überarbeitung ist
        // genau sie es, die drüben erhalten bleiben soll.
        void (async () => {
            const doc = await (prisma as any).ospDocument.findUnique({
                where: { id: row.id },
                select: {
                    id: true, reference: true, salespersonEmail: true,
                    salespersonName: true, salespersonProfile: true,
                },
            }).catch(() => null);
            if (doc) await reportOspDocumentStatus(setting, doc, row.status);
        })().catch(() => undefined);
    }
    for (const job of result.datasheetJobs) {
        void storeUnitDatasheet(setting, job.unitId, job.url, job.specs).catch(() => undefined);
    }
};

/* ── §1 — eine Anfrage, die wir noch nie gesehen haben (OFFER_WEBHOOK_URL) ───
   EIN Objekt: das Projekt, wer fragt, wohin es geht, und die zu offerierenden
   Datenblätter darunter. Es gibt keine Auswahl — die anfragende Person wird
   nicht gefragt, welche Einheiten mitsollen, denn eine Offerte gilt dem
   Projekt. Weggelassen wird nur, was noch gar kein Datenblatt hat. */
router.post('/webhook', async (req, res) => {
    try {
        const setting = await authenticateWebhook(req, res);
        if (!setting) return;
        const projects = normalizeOfferPayload(req.body);
        if (!projects.length) return res.status(400).json({ message: 'Empty payload.' });
        finishIngest(setting, res, await ingestOfferProjects(setting, projects, 'NEW'));
    } catch (error: any) {
        res.status(500).json({ message: error?.message || 'Webhook failed.' });
    }
});

/* ── §1a — die überarbeitete Anfrage (OFFER_REVISION_WEBHOOK_URL) ───────────
   Die anfragende Person hat das Projekt nach der Anfrage geändert (neu
   gerechnet, Optionen getauscht, umbenannt, Sprache gewechselt, oder bloss die
   Rufnummer berichtigt) und es ERNEUT angefragt. Der Körper ist derselbe wie in
   §1 — nur die Adresse ist eine andere, damit klar ist, dass es kein zweiter
   Interessent ist, sondern ein Ersatz für eine Anfrage, die schon in Arbeit
   ist.

   Ein Druck erzeugt GENAU EINEN Aufruf: ein Projekt ist entweder neu oder eine
   Überarbeitung, nie beides.

   Eine Überarbeitung ist ein NACHTRAG: `changes` sagt, was sich bewegt hat, und
   `projectDetails` trägt nur die Datenblätter, die deswegen neu gerendert
   wurden. Leer ist keine leere Anfrage, sondern die Aussage "das Projekt hat
   sich geändert, die Datenblätter nicht".

   Für ein bereits beantwortetes Projekt ("offer has been sent") kommt hier NIE
   etwas an — das schliesst die OSP für weitere Anfragen. Wieder zu öffnen ist
   es nur über §4b (Anfrage zurückziehen). */
router.post('/webhook/revision', async (req, res) => {
    try {
        const setting = await authenticateWebhook(req, res);
        if (!setting) return;
        const projects = normalizeOfferPayload(req.body);
        if (!projects.length) return res.status(400).json({ message: 'Empty payload.' });
        finishIngest(setting, res, await ingestOfferProjects(setting, projects, 'REVISION'));
    } catch (error: any) {
        res.status(500).json({ message: error?.message || 'Revision webhook failed.' });
    }
});

/* Die Adresse der zweiten Vertragsfassung (DOCUMENT_CHANGE_WEBHOOK_URL). Sie
   bleibt bestehen, solange die OSP sie noch eingetragen hat: dort hiess die
   Überarbeitung "Änderung" und kam als EINZELNES Objekt. Beide Formen landen
   auf derselben Auswertung — ein Feld ebenso wie ein einzelnes Objekt. */
router.post('/webhook/change', async (req, res) => {
    try {
        const setting = await authenticateWebhook(req, res);
        if (!setting) return;
        const projects = normalizeOfferPayload(req.body);
        if (!projects.length) return res.status(400).json({ message: 'Empty payload.' });
        finishIngest(setting, res, await ingestOfferProjects(setting, projects, 'REVISION'));
    } catch (error: any) {
        res.status(500).json({ message: error?.message || 'Change webhook failed.' });
    }
});

/* ── §1b — die Anfrage wurde zurückgezogen (OFFER_WITHDRAWAL_WEBHOOK_URL) ───
   Die anfragende Person nimmt ihre Anfrage im OSP zurück. EIN Objekt, und es
   trägt nur Kennungen und einen Zeitpunkt: wer das Projekt besitzt, wer es hier
   hält und in welchem Stand es steht, wissen wir längst — die OSP hat es in der
   Anfrage und in jeder Statusmeldung seither gesagt.

   Ein Rückzug nimmt die GANZE Anfrage zurück, nicht eine Einheit daraus.

   Zurückgezogen werden kann nur eine OFFENE Anfrage — ist die Offerte einmal
   draussen, verschwindet der Knopf drüben. Das Gegenstück in die andere
   Richtung ist §4b: dort sagen WIR der OSP, dass die Anfrage bei uns weg ist
   (das tut die Offertenlöschung).

   Gelöscht wird hier nichts. Die Zeile behält Offerte, Datenblätter und
   Zuständigkeit und wechselt auf WITHDRAWN — sichtbar, damit niemand
   weiterarbeitet, und rückholbar, falls neu angefragt wird. */
router.post('/webhook/withdrawal', async (req, res) => {
    try {
        const setting = await authenticateWebhook(req, res);
        if (!setting) return;

        const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
        const key = asKey(body?.projectNumber);
        if (!key) return res.status(400).json({ message: 'projectNumber is required.' });
        const { projectNumber } = parseReference(key);

        const doc = await findRequestRow(setting.tenantId, projectNumber);
        // Ein Rückzug zu einer Anfrage, die wir nie bekommen haben, ist kein
        // Fehler — die OSP wiederholt nicht, also freundlich quittieren.
        if (!doc) return res.status(200).json({ received: 1, matched: 0 });

        await (prisma as any).ospDocument.update({
            where: { id: doc.id },
            data: {
                status: 'WITHDRAWN',
                // `withdrawnAt` ist der Name der vierten Fassung, `withdrawn_at`
                // der der dritten. Fehlt beides, gilt der Augenblick.
                withdrawnAt: asDate(body?.withdrawnAt) || asDate(body?.withdrawn_at) || new Date(),
                // Die vierte Fassung schickt keine Person mehr mit; ältere
                // Fassungen taten es, und was einmal an der Zeile stand, soll
                // nicht durch null ersetzt werden.
                ...withoutEmpty({
                    withdrawnByName: [asTrimmed(body?.username), asTrimmed(body?.surname)].filter(Boolean).join(' ') || null,
                    withdrawnByEmail: asTrimmed(body?.email),
                    // Der Stand, in dem zurückgezogen wurde — drüben gesehen.
                    withdrawnFromStatus: asTrimmed(body?.offerStatus),
                }),
                // Der Rückzug beendet die Meldekette: was zuletzt gemeldet
                // wurde, gilt drüben nicht mehr, denn die OSP hat ihre Seite
                // bereits abgeräumt, bevor sie uns angerufen hat.
                lastReportedStatus: null,
                lastReportAt: null,
                lastReportError: null,
            },
        });

        // Zurückgemeldet wird NICHTS: die OSP räumt ihre Seite zuerst und
        // bedingungslos ab (§1b) — eine Statusmeldung darauf würde eine
        // Anfrage wiederbeleben, die es drüben nicht mehr gibt.
        res.status(200).json({ received: 1, matched: 1, status: 'WITHDRAWN' });
    } catch (error: any) {
        res.status(500).json({ message: error?.message || 'Withdrawal webhook failed.' });
    }
});

/* ── §1c — der Aktivitätsstrom (PROJECT_WEBHOOK_URL) ─────────────────────────
   Was drüben gerechnet wird, sobald es gerechnet wird: alle 30 Sekunden ein
   Bündel, eine Liste von PROJEKTEN mit den Berechnungen darunter, die in
   diesem Fenster in sie abgelegt wurden.

   Das ist AUSDRÜCKLICH KEINE ANFRAGE. Niemand hat um eine Offerte gebeten, es
   wird kein Stand eröffnet, und die OSP erwartet keine Antwort. Diese Zeilen
   landen deshalb NIE in der Anfrageliste, aus der der Verkauf arbeitet,
   sondern in ihrem eigenen Reiter — der Strom sagt, was gerechnet wird, nicht,
   was jemand zu tun aufgetragen hat.

   Zwei Dinge sind trotzdem zu tun:
    • Der Strom kommt MINDESTENS EINMAL. Bleibt unsere Quittung unterwegs,
      schickt die OSP dasselbe noch einmal — also wird auf (Mandant, Dokument-
      Id) eingesetzt oder aufgefrischt, nie angehängt.
    • JEDER Eintrag heisst, dass die PDF-Adresse sich bewegt hat und die alte
      GELÖSCHT ist. Halten wir zu diesem Beleg eine Anfrage, ist unser
      Datenblatt damit überholt und sein Link tot: die Einheit bekommt die neue
      Adresse, das PDF wird erneut geholt, und an der Anfrage steht, dass die
      OSP es neu gerendert hat. Ein Stand ändert sich dadurch nicht. */
router.post('/webhook/project', async (req, res) => {
    try {
        const setting = await authenticateWebhook(req, res);
        if (!setting) return;

        const rows = Array.isArray(req.body) ? req.body : (req.body ? [req.body] : []);
        const jobs: Array<{ unitId: string; url: string; specs: OspDatasheetSpecs }> = [];
        let projects = 0;
        let documents = 0;

        for (const raw of rows) {
            if (!raw || typeof raw !== 'object') continue;
            const entry = raw as Record<string, any>;
            const details = Array.isArray(entry.projectDetails) ? entry.projectDetails : [];
            if (!details.length) continue;
            projects += 1;

            const project = withoutEmpty({
                ospProjectId: Number.isFinite(Number(entry.projectId)) && entry.projectId !== null
                    ? Number(entry.projectId) : null,
                // Null nur bei einem alten Projekt, das nie eine bekam (§1c).
                projectNumber: asKey(entry.projectNumber),
                projectName: asTrimmed(entry.projectName),
                projectCreatedAt: asDate(entry.projectCreatedAt),
                requesterFirstName: asTrimmed(entry.username),
                requesterLastName: asTrimmed(entry.surname),
                requesterEmail: asTrimmed(entry.email),
                company: asTrimmed(entry.companyName),
            });

            for (const detail of details) {
                if (!detail || typeof detail !== 'object') continue;
                const ospDocumentId = asKey(detail.id);
                if (!ospDocumentId) continue;
                documents += 1;

                const source = asTrimmed(detail.source) || 'CALCULATION';
                const pdfUrl = pickDatasheetUrl(detail);
                const feed: any = {
                    ...project,
                    unitName: asTrimmed(detail.unitName),
                    unitModel: asTrimmed(detail.unitModel),
                    pdfUrl,
                    source,
                    filedAt: asDate(detail.filedAt),
                    // `null` heisst "gibt es an dieser Einheit nicht", nie 0 —
                    // also wird es auch als null abgelegt und nicht gefüllt.
                    coolingCapacityKw: asTrimmed(detail.coolingCapacityKw),
                    heatingCapacityKw: asTrimmed(detail.heatingCapacityKw),
                    eer: asTrimmed(detail.eer),
                    cop: asTrimmed(detail.cop),
                    rawPayload: detail as any,
                };

                await (prisma as any).ospFeedEntry.upsert({
                    where: { tenantId_ospDocumentId: { tenantId: setting.tenantId, ospDocumentId } },
                    create: {
                        id: nanoid(12), tenantId: setting.tenantId, ospDocumentId,
                        firstSeenAt: new Date(), ...feed,
                    },
                    update: feed,
                });

                /* Halten wir zu diesem Beleg eine Anfrage? Dann ist ihr
                   Datenblatt jetzt überholt — und zwar unabhängig davon,
                   welche der sieben Ursachen es war: jede rendert neu und
                   löscht die alte Datei. */
                const held = await (prisma as any).ospUnit.findFirst({
                    where: { tenantId: setting.tenantId, ospDocumentId },
                    select: { id: true, requestId: true, pdfUrl: true, unitName: true, unitModel: true },
                });
                if (!held) continue;

                const unitData: any = withoutEmpty({
                    unitName: held.unitName || asTrimmed(detail.unitName),
                    unitModel: held.unitModel || asTrimmed(detail.unitModel),
                });
                if (pdfUrl && pdfUrl !== held.pdfUrl) {
                    unitData.pdfUrl = pdfUrl;
                    jobs.push({ unitId: held.id, url: pdfUrl, specs: specsFromOfferEntry(detail) });
                }
                if (Object.keys(unitData).length) {
                    await (prisma as any).ospUnit.update({ where: { id: held.id }, data: unitData }).catch(() => undefined);
                }

                // Ein NEUER Beleg (CALCULATION / ADDED_TO_PROJECT) kann keine
                // Änderung an etwas sein, das wir halten; nur die fünf
                // Änderungsgründe stellen unser Datenblatt in Frage.
                if (source !== 'CALCULATION' && source !== 'ADDED_TO_PROJECT') {
                    await (prisma as any).ospDocument.update({
                        where: { id: held.requestId },
                        data: { feedRevisedAt: asDate(detail.filedAt) || new Date(), feedRevisedSource: source },
                    }).catch(() => undefined);
                }
            }
        }

        // Quittieren, dann in Ruhe die Dateien holen — die OSP wartet nicht,
        // sie zählt nur, ob wir 2xx gesagt haben.
        res.status(200).json({ received: rows.length, projects, documents, datasheets: jobs.length });
        for (const job of jobs) {
            void storeUnitDatasheet(setting, job.unitId, job.url, job.specs).catch(() => undefined);
        }
    } catch (error: any) {
        res.status(500).json({ message: error?.message || 'Project webhook failed.' });
    }
});

/* ── 2) Belegliste der OSP-Seite (Seiten zu 15) ──────────────────────────── */

router.get('/documents', requireAuth, requirePermission('tenders.view'), async (req, res) => {
    try {
        const tenantId = (req as any).user!.tenantId;
        const feed = await loadFeedContext(tenantId);
        if (!feed) return res.status(403).json({ error: 'Kein aktiver Firmenbaum.' });
        if (!feed.visible) return res.status(403).json({ error: 'OSP ist für diese Firma nicht freigeschaltet.' });

        const page = Math.max(1, Number(req.query.page) || 1);
        const pageSize = Math.min(50, Math.max(1, Number(req.query.pageSize) || PAGE_SIZE));
        const status = asTrimmed(req.query.status as string);
        const q = asTrimmed(req.query.q as string);

        const where: any = { tenantId: feed.rootId };
        if (status && (OSP_STATUSES as readonly string[]).includes(status)) where.status = status;
        if (q) {
            where.OR = [
                { reference: { contains: q } },
                { projectName: { contains: q } },
                { model: { contains: q } },
                { requesterFirstName: { contains: q } },
                { requesterLastName: { contains: q } },
                { requesterEmail: { contains: q } },
                { company: { contains: q } },
                { country: { contains: q } },
                // Gesucht wird auch in den Einheiten: Modell und Bezeichnung
                // stehen seit der vierten Vertragsfassung dort, nicht mehr an
                // der Anfrage.
                { units: { some: { unitModel: { contains: q } } } },
                { units: { some: { unitName: { contains: q } } } },
            ];
        }

        const [items, total, grouped] = await Promise.all([
            (prisma as any).ospDocument.findMany({
                where,
                orderBy: [{ ospCreatedAt: 'desc' }, { createdAt: 'desc' }],
                skip: (page - 1) * pageSize,
                take: pageSize,
            }),
            (prisma as any).ospDocument.count({ where }),
            (prisma as any).ospDocument.groupBy({
                by: ['status'],
                where: { tenantId: feed.rootId },
                _count: { _all: true },
            }),
        ]);

        /* Selbstheilung verwaister Verknüpfungen (27.08.2026): wurde die
           Offerte einer Zeile gelöscht, ohne dass die Zeile freigegeben wurde
           (Löschung über einen älteren Serverstand), verliert sie ihre
           tenderId HIER — und bietet sofort wieder "Offerte erstellen" an. */
        const linked = items.filter((doc: any) => doc.tenderId);
        if (linked.length) {
            const existingTenders = new Set((await prisma.tender.findMany({
                where: { id: { in: linked.map((doc: any) => doc.tenderId) } },
                select: { id: true },
            })).map((t) => t.id));
            const orphaned = linked.filter((doc: any) => !existingTenders.has(doc.tenderId));
            if (orphaned.length) {
                await (prisma as any).ospDocument.updateMany({
                    where: { id: { in: orphaned.map((doc: any) => doc.id) } },
                    data: { tenderId: null, tenderNumber: null },
                });
                for (const doc of orphaned) {
                    doc.tenderId = null;
                    doc.tenderNumber = null;
                }
            }
        }

        /* Sicherheitsnetz für den Stand: gemeldet wird "gesendet" am Mailweg
           der Offerte selbst (markOspOfferSent). Ging das damals daneben — der
           Serverstand war älter, der Aufruf brach ab —, holt die Liste es hier
           nach: hängt an einer Zeile eine Offerte, deren Angebotsmail HINAUS
           ist, rückt sie von IN_OFFER auf SENT vor und meldet es. */
        const mailCandidates = items.filter((doc: any) => doc.status === 'IN_OFFER' && doc.tenderId);
        if (mailCandidates.length) {
            const tenders = await prisma.tender.findMany({
                where: { id: { in: mailCandidates.map((doc: any) => doc.tenderId) } },
                select: { id: true, offerMailSentAt: true },
            });
            const sentTenders = new Set(tenders.filter((t) => t.offerMailSentAt).map((t) => t.id));
            for (const doc of mailCandidates) {
                if (!sentTenders.has(doc.tenderId)) continue;
                doc.status = 'SENT';
                await (prisma as any).ospDocument.update({ where: { id: doc.id }, data: { status: 'SENT' } });
                // Ohne Verkäufer:in lehnt die OSP "offer has been sent" mit 400
                // ab (§3) — der Stand bei uns stimmt trotzdem.
                if (doc.salespersonEmail) {
                    void reportOspDocumentStatus(feed.setting, doc, 'SENT').catch(() => undefined);
                }
            }
        }

        /* Die Einheiten der Seite in EINER Abfrage — `include` wäre je Zeile
           ein eigener Weg zur Datenbank. Sie tragen den Positionstitel und das
           Datenblatt, aus dem offeriert wird. */
        if (items.length) {
            const units = await (prisma as any).ospUnit.findMany({
                where: { requestId: { in: items.map((doc: any) => doc.id) } },
                orderBy: { createdAt: 'asc' },
            });
            const byRequest = new Map<string, any[]>();
            for (const unit of units) {
                const list = byRequest.get(unit.requestId);
                if (list) list.push(unit);
                else byRequest.set(unit.requestId, [unit]);
            }
            for (const doc of items) doc.units = byRequest.get(doc.id) || [];
        }

        const counts: Record<OspStatus, number> = { LISTED: 0, IN_OFFER: 0, SENT: 0, APPROVED: 0, WITHDRAWN: 0 };
        for (const row of grouped as Array<{ status: string; _count: { _all: number } }>) {
            if ((OSP_STATUSES as readonly string[]).includes(row.status)) {
                counts[row.status as OspStatus] = row._count._all;
            }
        }

        res.json({
            items,
            total,
            page,
            pageSize,
            totalPages: Math.max(1, Math.ceil(total / pageSize)),
            counts,
            configured: Boolean(feed.setting),
        });
    } catch (error: any) {
        res.status(500).json({ error: error?.message || 'OSP-Liste fehlgeschlagen.' });
    }
});

/* ── 3) Zeile pflegen: die zuständige Verkäuferin / der zuständige Verkäufer ─
   EINE Zuständigkeit, direkt gewählt (19.09.2026): die Projektleitung als
   zweites Feld ist weg — an der Anfrage steht die Person, die die Offerte
   macht, und genau die geht als `salesman` an die OSP.

   Der STAND wird dabei nicht gewählt, sondern folgt (siehe
   `statusForAssignment`): wer eine Person einträgt, setzt die Anfrage auf
   "Verkäufer zugewiesen" und meldet der OSP "under review"; wer sie
   herausnimmt, stellt sie zurück auf "Gelistet". */

router.patch('/documents/:id', requireAuth, requirePermission('tenders.manage'), async (req, res) => {
    try {
        const tenantId = (req as any).user!.tenantId;
        const feed = await loadFeedContext(tenantId);
        if (!feed?.visible) return res.status(403).json({ error: 'OSP ist für diese Firma nicht freigeschaltet.' });

        const doc = await (prisma as any).ospDocument.findFirst({
            where: { id: req.params.id, tenantId: feed.rootId },
        });
        if (!doc) return res.status(404).json({ error: 'OSP-Beleg nicht gefunden.' });

        const data: any = {};
        const body = req.body || {};

        if (body.salespersonId !== undefined) {
            if (!body.salespersonId) {
                data.salespersonId = null;
                data.salespersonEmail = null;
                data.salespersonName = null;
                data.salespersonProfile = null;
            } else {
                // Person kommt aus dem Personalverzeichnis — Name und E-Mail
                // werden hier aufgelöst, nie vom Client übernommen. Und zwar
                // aus dem Verzeichnis der AUSGEWÄHLTEN Firma: die OSP-Liste
                // hängt zwar am Stamm, die Zuständigen sind aber Leute der
                // eigenen Firma.
                const employee = await prisma.employee.findFirst({
                    where: { id: String(body.salespersonId), ...employeeScopeWhere(await getPersonnelTenantScope(tenantId)) },
                    select: { id: true, firstName: true, lastName: true, email: true, phone: true },
                });
                if (!employee) return res.status(404).json({ error: 'Mitarbeiter nicht gefunden.' });
                data.salespersonId = employee.id;
                data.salespersonEmail = employee.email || null;
                data.salespersonName = employeeDisplayName(employee);
                // Die Visitenkarte, die §3 mitschickt.
                data.salespersonProfile = salesmanProfileOf(employee) as any;
            }
        }

        const nextEmail: string | null = data.salespersonEmail !== undefined ? data.salespersonEmail : doc.salespersonEmail;
        // Der Stand folgt der Zuständigkeit — von Hand gesetzt wird er nicht.
        const nextStatus = statusForAssignment(doc.status, Boolean(nextEmail));
        if (nextStatus !== doc.status) data.status = nextStatus;

        // "under review" ist ohne Verkäufer:in bedeutungslos — die OSP lehnt es
        // mit 400 ab. Wer eine Person OHNE E-Mail-Adresse wählt, bekommt das
        // hier gesagt, statt dass die Meldung später still an der Zeile
        // scheitert.
        if (body.salespersonId && !nextEmail) {
            return res.status(400).json({ error: 'Diese Person hat keine E-Mail-Adresse — die OSP braucht sie, um die Zuweisung anzuzeigen.' });
        }

        const updatedDoc = await (prisma as any).ospDocument.update({ where: { id: doc.id }, data });

        /* Gemeldet wird jede ECHTE Änderung der Zuweisung:
            • Person gewählt/gewechselt → "under review" mit ihrer Visitenkarte
              (auch beim Wechsel — die OSP ersetzt sonst die alte Karte nicht),
            • Person entfernt, solange die Offerte noch nicht hinaus ist →
              "created" ohne Karte, denn drüben stünde sonst weiterhin jemand,
              der die Anfrage gar nicht mehr bearbeitet. Eine GESENDETE Offerte
              rührt das nicht an: sie ist beim Kunden. */
        const personChanged = nextEmail !== doc.salespersonEmail;
        if (personChanged && (nextStatus === 'IN_OFFER' || nextStatus === 'LISTED')) {
            await reportOspDocumentStatus(feed.setting, updatedDoc, nextStatus);
        }

        res.json(await (prisma as any).ospDocument.findUnique({ where: { id: doc.id } }));
    } catch (error: any) {
        res.status(500).json({ error: error?.message || 'OSP-Beleg konnte nicht gespeichert werden.' });
    }
});

/* ── 3a) Die Anfrage zu einer OFFERTE — für die Offertenseite ───────────────
   Die Offerte weiss von sich aus nichts über ihre Herkunft. Diese Adresse
   beantwortet die eine Frage, die sie stellt: "komme ich aus der OSP, und was
   ist seither passiert?" Ohne Zeile antwortet sie mit `null` — das ist der
   Normalfall und kein Fehler. */

router.get('/documents/by-tender/:tenderId', requireAuth, requirePermission('tenders.view'), async (req, res) => {
    try {
        const feed = await loadFeedContext((req as any).user!.tenantId);
        // Ohne freigeschaltete OSP gibt es zu einer Offerte schlicht nichts zu
        // sagen — das ist keine Zugriffsverweigerung, sondern "keine Zeile".
        if (!feed?.visible) return res.json({ document: null });
        const doc = await (prisma as any).ospDocument.findFirst({
            where: { tenderId: req.params.tenderId, tenantId: feed.rootId },
            include: { units: { orderBy: { createdAt: 'asc' } } },
        });
        res.json({ document: doc || null });
    } catch (error: any) {
        res.status(500).json({ error: error?.message || 'OSP-Beleg konnte nicht geladen werden.' });
    }
});

/* ── 3c) Die Überarbeitung zur Kenntnis nehmen (§1a) ─────────────────────────
   Die Warnung an der Offerte steht, solange die Überarbeitung jünger ist als
   dieser Stempel. Gelöscht wird dabei nichts: `revisedAt` bleibt stehen, die
   Zeile sagt weiterhin, dass und wann die Einheit neu gerechnet wurde. */

router.post('/documents/:id/revision-seen', requireAuth, requirePermission('tenders.manage'), async (req, res) => {
    try {
        const feed = await loadFeedContext((req as any).user!.tenantId);
        if (!feed?.visible) return res.status(403).json({ error: 'OSP ist für diese Firma nicht freigeschaltet.' });
        const doc = await (prisma as any).ospDocument.findFirst({
            where: { id: req.params.id, tenantId: feed.rootId },
            select: { id: true },
        });
        if (!doc) return res.status(404).json({ error: 'OSP-Beleg nicht gefunden.' });
        res.json(await (prisma as any).ospDocument.update({
            where: { id: doc.id },
            data: { revisionSeenAt: new Date() },
        }));
    } catch (error: any) {
        res.status(500).json({ error: error?.message || 'Speichern fehlgeschlagen.' });
    }
});

/* ── 3d) Die Anfrage LÖSCHEN — und den Rückzug drüben melden (§4b) ───────────
   Der Vertrag verlangt für Zeilen aus der OSP einen Löschknopf, der
   `DELETE /integration/offer-status/{reference}` ruft: die Methode SELBST ist
   die Meldung "gelöscht", einen Status `deleted` gibt es nicht. Drüben wird
   dabei nichts gelöscht — Status und Zuständigkeit werden geleert, und die
   anfragende Person darf neu anfragen.

   Erst wenn die OSP mit 2xx quittiert hat, verschwindet die Zeile hier: sonst
   wüssten die beiden Seiten Verschiedenes, ohne dass es jemandem auffiele. Ist
   gar kein OSP-Zugang hinterlegt, gibt es nichts zu melden und die Zeile geht.

   Die Offerte, die aus der Anfrage entstanden ist, bleibt bestehen — sie ist
   ein eigener Beleg. Sie verliert nur ihre Herkunft. */

router.delete('/documents/:id', requireAuth, requirePermission('tenders.manage'), async (req, res) => {
    try {
        const feed = await loadFeedContext((req as any).user!.tenantId);
        if (!feed?.visible) return res.status(403).json({ error: 'OSP ist für diese Firma nicht freigeschaltet.' });

        const doc = await (prisma as any).ospDocument.findFirst({
            where: { id: req.params.id, tenantId: feed.rootId },
            select: {
                id: true, reference: true, datasheetFile: true,
                units: { select: { datasheetFile: true } },
            },
        });
        if (!doc) return res.status(404).json({ error: 'OSP-Beleg nicht gefunden.' });

        const result = feed.setting
            ? await withdrawOspOfferStatus(feed.setting, doc.reference)
            : { ok: false, skipped: true as const, notFound: false, error: undefined };
        // Kennt die OSP den Beleg gar nicht (404), ist der Rückzug bereits
        // erreicht: dort steht nichts mehr, was unsere Zeile noch trüge. Sie
        // hier dann festzuhalten hiesse, sie nie mehr loszuwerden.
        if (!result.ok && !result.skipped && !result.notFound) {
            // Sichtbar stehen lassen und den Grund an die Zeile schreiben —
            // erneut versuchen kann man danach mit demselben Knopf.
            await (prisma as any).ospDocument.update({
                where: { id: doc.id },
                data: { lastReportError: result.error || 'Rückzug bei der OSP fehlgeschlagen.' },
            }).catch(() => undefined);
            return res.status(502).json({ error: result.error || 'Die OSP hat den Rückzug nicht bestätigt — die Anfrage bleibt stehen.' });
        }

        // Die Einheiten nimmt die Fremdschlüsselkette mit; ihre DATEIEN nicht.
        await (prisma as any).ospDocument.delete({ where: { id: doc.id } });
        // Ein abgelegtes Datenblatt gehörte zur Anfrage und hat ohne sie keinen
        // Ort mehr. Best-Effort: eine Datei, die nicht wegzuräumen ist, darf
        // die Löschung nicht scheitern lassen.
        const files: string[] = [
            doc.datasheetFile,
            ...(doc.units || []).map((unit: any) => unit.datasheetFile),
        ].filter(Boolean);
        for (const file of files) await ospDatasheetStorage.remove(file).catch(() => undefined);

        res.json({ deleted: true, reference: doc.reference, reported: result.ok });
    } catch (error: any) {
        res.status(500).json({ error: error?.message || 'OSP-Beleg konnte nicht gelöscht werden.' });
    }
});

/* ── 3b) Das Datenblatt EINER EINHEIT: öffnen und (bei Bedarf) erneut holen ──
   Ein Projekt hält mehrere Einheiten, und jede hat ihr eigenes Datenblatt (§1).
   Angesprochen wird deshalb die Einheit, nicht die Anfrage. */

/** Die Einheit samt ihrer Anfrage — und nur im eigenen Firmenbaum. */
const findUnit = async (rootId: string, unitId: string): Promise<any | null> => (
    (prisma as any).ospUnit.findFirst({
        where: { id: unitId, tenantId: rootId },
        include: { request: { select: { id: true, reference: true } } },
    })
);

/**
 * Das abgelegte PDF ausliefern. Es geht durch UNSER Programm, nicht als Link
 * auf die OSP: die Adresse drüben stirbt bei der nächsten Neuberechnung (§1c),
 * und die Datei soll auch dann noch aufgehen, wenn die Anfrage längst erledigt
 * ist.
 */
router.get('/units/:unitId/datasheet', requireAuth, requirePermission('tenders.view'), async (req, res) => {
    try {
        const feed = await loadFeedContext((req as any).user!.tenantId);
        if (!feed?.visible) return res.status(403).json({ error: 'OSP ist für diese Firma nicht freigeschaltet.' });

        const unit = await findUnit(feed.rootId, String(req.params.unitId));
        if (!unit) return res.status(404).json({ error: 'OSP-Einheit nicht gefunden.' });
        if (!unit.datasheetFile) return res.status(404).json({ error: 'Zu dieser Einheit liegt kein Datenblatt.' });

        const body = await ospDatasheetStorage.read(unit.datasheetFile);
        res.setHeader('Content-Type', 'application/pdf');
        // `inline`: das Datenblatt gehört angeschaut, nicht heruntergeladen.
        const name = [unit.request?.reference, unit.ospDocumentId].filter(Boolean).join('-');
        res.setHeader('Content-Disposition', `inline; filename="Datenblatt-${name}.pdf"`);
        res.setHeader('Content-Length', String(body.length));
        res.end(body);
    } catch (error: any) {
        res.status(500).json({ error: error?.message || 'Datenblatt konnte nicht geladen werden.' });
    }
});

/**
 * Erneut holen — wenn die OSP beim ersten Versuch schwieg, oder wenn der
 * Aktivitätsstrom (§1c) eine neue Adresse gebracht hat und die alte Datei
 * drüben bereits gelöscht ist.
 */
router.post('/units/:unitId/datasheet', requireAuth, requirePermission('tenders.manage'), async (req, res) => {
    try {
        const feed = await loadFeedContext((req as any).user!.tenantId);
        if (!feed?.visible) return res.status(403).json({ error: 'OSP ist für diese Firma nicht freigeschaltet.' });
        if (!feed.setting) return res.status(400).json({ error: 'OSP ist noch nicht konfiguriert.' });

        const unit = await findUnit(feed.rootId, String(req.params.unitId));
        if (!unit) return res.status(404).json({ error: 'OSP-Einheit nicht gefunden.' });
        // Die Adresse darf auch von Hand kommen — dann steht sie danach an der
        // Einheit und gilt als das Datenblatt dieser Einheit.
        const url = asTrimmed(req.body?.pdfUrl) || asTrimmed(req.body?.datasheetUrl) || unit.pdfUrl;
        if (!url) return res.status(400).json({ error: 'Die OSP hat zu dieser Einheit keine Datenblatt-Adresse geliefert.' });
        if (url !== unit.pdfUrl) {
            await (prisma as any).ospUnit.update({ where: { id: unit.id }, data: { pdfUrl: url } });
        }

        // Was §1 selbst mitgeschickt hat, gilt weiterhin vor dem PDF — sonst
        // würde ein erneutes Holen die genaueren Zahlen durch die aus dem
        // Fliesstext gelesenen ersetzen.
        await storeUnitDatasheet(feed.setting, unit.id, url, specsFromOfferEntry(unit.rawPayload));
        res.json(await (prisma as any).ospUnit.findUnique({ where: { id: unit.id } }));
    } catch (error: any) {
        res.status(500).json({ error: error?.message || 'Datenblatt konnte nicht geholt werden.' });
    }
});

/* Die Adressen VOR der vierten Vertragsfassung sprachen die ANFRAGE an, weil
   sie damals genau eine Einheit war. Sie bleiben stehen und beantworten sich
   aus deren erster Einheit — eine offene Oberfläche eines älteren Standes soll
   nicht ins Leere greifen. */
const firstUnitOf = async (rootId: string, requestId: string): Promise<any | null> => (
    (prisma as any).ospUnit.findFirst({
        where: { requestId, tenantId: rootId },
        orderBy: { createdAt: 'asc' },
        include: { request: { select: { id: true, reference: true } } },
    })
);

router.get('/documents/:id/datasheet', requireAuth, requirePermission('tenders.view'), async (req, res) => {
    try {
        const feed = await loadFeedContext((req as any).user!.tenantId);
        if (!feed?.visible) return res.status(403).json({ error: 'OSP ist für diese Firma nicht freigeschaltet.' });

        const unit = await firstUnitOf(feed.rootId, String(req.params.id));
        if (!unit?.datasheetFile) return res.status(404).json({ error: 'Zu diesem Beleg liegt kein Datenblatt.' });

        const body = await ospDatasheetStorage.read(unit.datasheetFile);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="Datenblatt-${unit.request?.reference || unit.id}.pdf"`);
        res.setHeader('Content-Length', String(body.length));
        res.end(body);
    } catch (error: any) {
        res.status(500).json({ error: error?.message || 'Datenblatt konnte nicht geladen werden.' });
    }
});

router.post('/documents/:id/datasheet', requireAuth, requirePermission('tenders.manage'), async (req, res) => {
    try {
        const feed = await loadFeedContext((req as any).user!.tenantId);
        if (!feed?.visible) return res.status(403).json({ error: 'OSP ist für diese Firma nicht freigeschaltet.' });
        if (!feed.setting) return res.status(400).json({ error: 'OSP ist noch nicht konfiguriert.' });

        const unit = await firstUnitOf(feed.rootId, String(req.params.id));
        const url = asTrimmed(req.body?.datasheetUrl) || unit?.pdfUrl;
        if (!unit || !url) {
            return res.status(400).json({ error: 'Die OSP hat zu diesem Beleg keine Datenblatt-Adresse geliefert.' });
        }
        if (url !== unit.pdfUrl) {
            await (prisma as any).ospUnit.update({ where: { id: unit.id }, data: { pdfUrl: url } });
        }
        await storeUnitDatasheet(feed.setting, unit.id, url, specsFromOfferEntry(unit.rawPayload));
        res.json(await (prisma as any).ospDocument.findUnique({
            where: { id: req.params.id },
            include: { units: { orderBy: { createdAt: 'asc' } } },
        }));
    } catch (error: any) {
        res.status(500).json({ error: error?.message || 'Datenblatt konnte nicht geholt werden.' });
    }
});

/* ── 3e) Der Aktivitätsstrom (§1c) — ein eigener Reiter, keine Anfrageliste ──
   Was drüben gerechnet wird. Niemand hat hier um etwas gebeten: die Liste ist
   zum ANSCHAUEN da und trägt darum weder Stand noch Zuständigkeit noch einen
   Knopf, der eine Offerte daraus machte. Taucht ein Beleg später doch in einer
   Anfrage auf, erkennt man ihn an derselben Projektnummer. */

router.get('/feed', requireAuth, requirePermission('tenders.view'), async (req, res) => {
    try {
        const feed = await loadFeedContext((req as any).user!.tenantId);
        if (!feed) return res.status(403).json({ error: 'Kein aktiver Firmenbaum.' });
        if (!feed.visible) return res.status(403).json({ error: 'OSP ist für diese Firma nicht freigeschaltet.' });

        const page = Math.max(1, Number(req.query.page) || 1);
        const pageSize = Math.min(50, Math.max(1, Number(req.query.pageSize) || PAGE_SIZE));
        const q = asTrimmed(req.query.q as string);

        const where: any = { tenantId: feed.rootId };
        if (q) {
            where.OR = [
                { projectNumber: { contains: q } },
                { projectName: { contains: q } },
                { unitName: { contains: q } },
                { unitModel: { contains: q } },
                { requesterEmail: { contains: q } },
                { company: { contains: q } },
            ];
        }

        const [items, total] = await Promise.all([
            (prisma as any).ospFeedEntry.findMany({
                where,
                orderBy: [{ filedAt: 'desc' }, { createdAt: 'desc' }],
                skip: (page - 1) * pageSize,
                take: pageSize,
            }),
            (prisma as any).ospFeedEntry.count({ where }),
        ]);

        /* Welche dieser Belege halten wir als Anfrage? Der Strom sagt es
           NICHT — ob ein Projekt neu ist, ist eine Tatsache über UNSERE
           Aufzeichnungen und nicht über die der OSP (§1c). Eine Abfrage
           beantwortet sie für die Seite, damit dort steht, was schon in Arbeit
           ist und was bloss gerechnet wurde. */
        const held = items.length
            ? await (prisma as any).ospUnit.findMany({
                where: {
                    tenantId: feed.rootId,
                    ospDocumentId: { in: items.map((row: any) => row.ospDocumentId) },
                },
                select: {
                    ospDocumentId: true,
                    requestId: true,
                    request: { select: { status: true, tenderId: true, tenderNumber: true } },
                },
            })
            : [];
        const byDocument = new Map<string, any>(held.map((unit: any) => [unit.ospDocumentId, unit]));
        for (const row of items) {
            const unit = byDocument.get(row.ospDocumentId);
            row.requestId = unit?.requestId || null;
            row.requestStatus = unit?.request?.status || null;
            row.tenderId = unit?.request?.tenderId || null;
            row.tenderNumber = unit?.request?.tenderNumber || null;
        }

        res.json({
            items,
            total,
            page,
            pageSize,
            totalPages: Math.max(1, Math.ceil(total / pageSize)),
        });
    } catch (error: any) {
        res.status(500).json({ error: error?.message || 'OSP-Aktivität konnte nicht geladen werden.' });
    }
});

/* ── 4) Import: Offerte aus einem OSP-Beleg erzeugen ─────────────────────── */

router.post('/documents/:id/import', requireAuth, requirePermission('tenders.manage'), async (req, res) => {
    try {
        const user = (req as any).user!;
        const feed = await loadFeedContext(user.tenantId);
        if (!feed?.visible) return res.status(403).json({ error: 'OSP ist für diese Firma nicht freigeschaltet.' });

        const doc = await (prisma as any).ospDocument.findFirst({
            where: { id: req.params.id, tenantId: feed.rootId },
        });
        if (!doc) return res.status(404).json({ error: 'OSP-Beleg nicht gefunden.' });
        if (doc.tenderId) {
            const existing = await prisma.tender.findFirst({ where: { id: doc.tenderId }, select: { id: true } });
            if (existing) return res.status(409).json({ error: 'Zu diesem Beleg besteht bereits eine Offerte.', tenderId: doc.tenderId });
        }

        const body = req.body || {};
        const customerId = asTrimmed(body.customerId);
        const manual = body.manualCustomer && typeof body.manualCustomer === 'object' ? body.manualCustomer : null;
        const manualName = manual ? asTrimmed(manual.name) : null;
        // Kein Name ist KEIN Fehler mehr (27.08.2026): der Import läuft ohne
        // Fenster durch, und der Kundenname ist an der Offerte frei tippbar —
        // eine Anfrage ohne Firmennamen erzeugt schlicht eine Offerte ohne
        // Kundschaft, die danach dort erfasst wird.
        let crmCustomer: {
            id: string; companyName: string; mainEmail: string | null;
            address: string | null; postalCode: string | null; city: string | null; country: string | null;
        } | null = null;
        if (customerId) {
            crmCustomer = await prisma.customer.findFirst({
                where: { id: customerId, tenantId: user.tenantId },
                select: {
                    id: true, companyName: true, mainEmail: true,
                    address: true, postalCode: true, city: true, country: true,
                },
            });
            if (!crmCustomer) return res.status(404).json({ error: 'Kunde nicht gefunden.' });
        }

        /* EINE POSITION JE EINHEIT (vierte Vertragsfassung): ein Projekt wird
           als Ganzes angefragt, und jede angefragte Einheit ist eine Zeile der
           Offerte — mit ihrem eigenen Datenblatt und ihren eigenen Zahlen.

           Die Beschreibungen baut die Oberfläche (dort steht die Schablone);
           schickt sie keine, entsteht trotzdem je Einheit eine Zeile, damit
           niemand eine Einheit verliert, bloss weil kein Datenblatt vorlag. */
        const units = await (prisma as any).ospUnit.findMany({
            where: { requestId: doc.id },
            orderBy: { createdAt: 'asc' },
        });
        const rawPositions = Array.isArray(body.positions) && body.positions.length
            ? body.positions
            : units.map((unit: any, index: number) => ({
                title: unit.unitModel || unit.unitName
                    || [doc.projectName, units.length > 1 ? `(${index + 1})` : null].filter(Boolean).join(' ')
                    || doc.reference,
            }));
        const positions = rawPositions
            .map((row: any) => ({
                title: asTrimmed(row?.title),
                descriptionHtml: typeof row?.descriptionHtml === 'string' ? row.descriptionHtml : null,
                quantity: Number.isFinite(Number(row?.quantity)) ? Math.max(0, Number(row.quantity)) : 1,
                unit: asTrimmed(row?.unit) || 'Stk',
                unitPrice: Number.isFinite(Number(row?.unitPrice)) ? Math.max(0, Number(row.unitPrice)) : 0,
                taxRate: Number.isFinite(Number(row?.taxRate)) ? Math.max(0, Number(row.taxRate)) : 8.1,
            }))
            .filter((row: any) => row.title);
        if (!positions.length) return res.status(400).json({ error: 'Mindestens eine Position angeben.' });

        // Zuständig ist EINE Person: die Verkäuferin/der Verkäufer. Gewählt
        // an der Zeile, im Aufruf mitgegeben — oder, wenn beides fehlt, die
        // Person, die den Import auslöst.
        const findEmployee = async (employeeId: string) => {
            const employee = await prisma.employee.findFirst({
                where: { id: employeeId, ...employeeScopeWhere(await getPersonnelTenantScope(user.tenantId)) },
                select: { id: true, firstName: true, lastName: true, email: true, phone: true },
            });
            return employee
                ? {
                    id: employee.id,
                    email: employee.email || null,
                    name: employeeDisplayName(employee),
                    profile: salesmanProfileOf(employee),
                }
                : null;
        };

        let salesperson: { id: string; email: string | null; name: string; profile?: OspSalesmanDto } | null = doc.salespersonId
            ? { id: doc.salespersonId, email: doc.salespersonEmail, name: doc.salespersonName }
            : null;
        const requestedSalespersonId = asTrimmed(body.salespersonId);
        if (requestedSalespersonId) {
            salesperson = await findEmployee(requestedSalespersonId);
            if (!salesperson) return res.status(404).json({ error: 'Mitarbeiter nicht gefunden.' });
        }
        if (!salesperson) {
            // Niemand gewählt: es ist die Person, die den Import auslöst.
            salesperson = await findEmployee(user.id)
                ?? { id: user.id, email: user.email || null, name: employeeDisplayName(user) };
        }

        /* Mehrzeilige manuelle Adresse: Strasse / PLZ Ort / Land.

           Die OSP schickt ihre Adressen seit der dritten Vertragsfassung als
           EINEN fertigen Satz ("Bahnhofstrasse 12, 8005 Zürich") statt in
           Bestandteilen. Was darin schon steht, wird deshalb nicht noch einmal
           angehängt — sonst stünde der Ort zweimal untereinander. */
        const streetLine = manual ? asTrimmed(manual.address) : null;
        const alreadyNamed = (value: string | null): boolean =>
            Boolean(value && streetLine && streetLine.toLowerCase().includes(value.toLowerCase()));
        const placeLine = manual
            ? [asTrimmed(manual.postalCode), asTrimmed(manual.city)].filter(Boolean).join(' ') || null
            : null;
        const countryLine = manual ? asTrimmed(manual.country) : null;
        const manualAddress = manual
            ? [
                streetLine,
                alreadyNamed(placeLine) ? null : placeLine,
                alreadyNamed(countryLine) ? null : countryLine,
            ].filter(Boolean).join('\n') || null
            : null;
        const manualEmail = manual ? asTrimmed(manual.email) : null;

        // Die manuellen Felder sind die OFFERTEN-EIGENEN Angaben und gelten vor
        // dem Kundenstamm (siehe TenderRepository). Bei einem CRM-Kunden wird
        // deshalb nur festgehalten, was von seiner Karte ABWEICHT — sonst fröre
        // die Offerte eine Kopie ein, die spätere Korrekturen am Kunden nicht
        // mehr mitbekäme. Geschrieben wird in KEINEM Fall zurück in den Stamm.
        const deviating = (value: string | null, ofCustomer: string | null | undefined): string | null => {
            if (!value) return null;
            if (!crmCustomer) return value;
            return value.trim() === String(ofCustomer ?? '').trim() ? null : value;
        };
        const crmAddress = crmCustomer ? formatCustomerAddress(crmCustomer as any) : null;

        const tenderNumber = await nextDocumentNumber(user.tenantId, 'QUOTE');
        const validUntil = new Date();
        validUntil.setDate(validUntil.getDate() + 30);

        const tender = await prisma.tender.create({
            data: {
                id: nanoid(10),
                tenantId: user.tenantId,
                customerId: customerId || null,
                tenderNumber,
                version: 1,
                format: 'SIA451',
                status: 'Draft',
                validUntil,
                // Die OSP-Referenz ist die "Referenz" der Offerte — so findet
                // man den Beleg auf dem PDF und in der OSP wieder.
                customerReference: doc.reference,
                salespersonName: salesperson.name || null,
                manualCustomerName: deviating(manualName, crmCustomer?.companyName),
                manualCustomerEmail: deviating(manualEmail, crmCustomer?.mainEmail),
                manualCustomerAddress: deviating(manualAddress, crmAddress),
                // Popup'ta düzenlenen adres yalnız bu teklifin adresidir.
                // Bir CRM müşterisi seçilmiş olsa da müşteri kartına yazılmaz.
                billingAddress: manualAddress,
                createdByEmployeeId: user.id,
            } as any,
        });

        // Reine Textpositionen — bewusst OHNE Artikelbezug: nichts davon
        // erscheint je im Lager oder im Artikelstamm.
        await prisma.position.createMany({
            data: positions.map((row: any, index: number) => ({
                id: nanoid(10),
                tenantId: user.tenantId,
                tenderId: tender.id,
                rowType: 'CUSTOM',
                positionNumber: String(index + 1),
                shortDescription: row.title,
                longDescription: row.descriptionHtml,
                quantity: row.quantity,
                unit: row.unit,
                unitPrice: row.unitPrice,
                taxRate: row.taxRate,
                displayOrder: index,
                hierarchyLevel: 0,
            })),
        });

        await (prisma as any).tenderActivityLog.create({
            data: {
                id: nanoid(12),
                tenantId: user.tenantId,
                tenderId: tender.id,
                employeeId: user.id,
                actionType: 'TENDER_CREATED',
                newValue: tenderNumber,
                description: `${tenderNumber} aus OSP-Beleg ${doc.reference} erzeugt.`,
            },
        }).catch(() => undefined);

        const updatedDoc = await (prisma as any).ospDocument.update({
            where: { id: doc.id },
            data: {
                status: 'IN_OFFER',
                tenderId: tender.id,
                tenderNumber,
                salespersonId: salesperson.id,
                salespersonEmail: salesperson.email,
                salespersonName: salesperson.name,
                ...(salesperson.profile ? { salespersonProfile: salesperson.profile as any } : {}),
            },
        });

        // "under review" braucht die zuständige Person — ohne E-Mail-Adresse
        // wird gar nicht gemeldet (die OSP würde mit 400 ablehnen).
        if (salesperson.email) {
            await reportOspDocumentStatus(feed.setting, updatedDoc, 'IN_OFFER');
        }

        res.status(201).json({
            tenderId: tender.id,
            tenderNumber,
            document: await (prisma as any).ospDocument.findUnique({
                where: { id: doc.id },
                include: { units: { orderBy: { createdAt: 'asc' } } },
            }) || updatedDoc,
        });
    } catch (error: any) {
        res.status(500).json({ error: error?.message || 'OSP-Import fehlgeschlagen.' });
    }
});

/* ── 5) Abgleich mit der OSP ("Transfer") — in Gruppen von 15 ────────────── */

router.post('/sync', requireAuth, requirePermission('tenders.manage'), async (req, res) => {
    try {
        const tenantId = (req as any).user!.tenantId;
        const feed = await loadFeedContext(tenantId);
        if (!feed?.visible) return res.status(403).json({ error: 'OSP ist für diese Firma nicht freigeschaltet.' });
        if (!feed.setting) return res.status(400).json({ error: 'OSP ist noch nicht konfiguriert.' });

        const docs = await (prisma as any).ospDocument.findMany({
            where: { tenantId: feed.rootId },
            select: {
                id: true, reference: true, projectNumber: true, status: true,
                salespersonEmail: true, salespersonName: true, salespersonProfile: true,
                lastReportedStatus: true, feedRevisedAt: true,
            },
        });
        if (!docs.length) return res.json({ checked: 0, updated: 0, failed: 0 });

        /* EINE Abfrage je PROJEKTNUMMER — seit der vierten Vertragsfassung ist
           der Stand eine Eigenschaft des Projekts, und §4 antwortet mit EINEM
           Objekt (oder `null`, wenn niemand dort je eine Offerte angefragt
           hat). Gezogen wird in Gruppen von 15 (Vorgabe).

           Zugeordnet wird über die abgefragte Nummer, nicht über die Referenz
           der Antwort: eine alte Zeile heisst hier noch "4820193-57", die
           Antwort drüben aber immer "4820193". */
        const projectNumbers: string[] = Array.from(new Set(docs.map((d: any) => String(d.projectNumber)).filter(Boolean)));
        const byProject = new Map<string, OspStatusRow>();
        let failed = 0;
        for (let start = 0; start < projectNumbers.length; start += 15) {
            const chunk = projectNumbers.slice(start, start + 15);
            const results = await Promise.all(chunk.map(async (projectNumber) => ({
                projectNumber,
                result: await fetchOspOfferStatus(feed.setting, projectNumber),
            })));
            for (const { projectNumber, result } of results) {
                if (!result.ok) { failed += 1; continue; }
                // Eine leere Antwort ist eine ANTWORT: dieses Projekt trägt
                // drüben gar keine Anfrage (mehr) — dann gibt es nichts
                // abzugleichen, und schon gar nichts vorzurücken.
                const row = (result.rows || [])[0];
                if (row?.status) byProject.set(projectNumber, row);
            }
        }

        let updated = 0;
        for (const doc of docs) {
            const row = byProject.get(String(doc.projectNumber));
            if (!row) continue;
            // Eine zurückgezogene Anfrage bleibt zurückgezogen: die OSP hat
            // ihre Seite abgeräumt und meldet dazu gar keinen Stand mehr —
            // was hier ankäme, wäre der einer NEUEN Anfrage, und die kommt
            // ihrerseits über §1.
            if (doc.status === 'WITHDRAWN') continue;
            const mapped = OSP_ENUM_TO_INTERNAL[String(row.status || '').toUpperCase()] || null;
            const data: any = {};
            // Der Abgleich bewegt den Stand nur VORWÄRTS — was hier weiter ist
            // (z. B. APPROVED, das die OSP nicht kennt), bleibt stehen.
            if (mapped && (OSP_STATUS_RANK[mapped] ?? -1) > (OSP_STATUS_RANK[doc.status] ?? 0)) {
                data.status = mapped;
            }
            if (mapped) data.lastReportedStatus = OSP_WIRE_STATUS[mapped] ?? doc.lastReportedStatus;
            /* Die OSP sagt selbst, wenn ein Datenblatt des Projekts überholt
               ist (§3 `documentOutdated`) — sie führt das auf ihrer Seite
               ohnehin, um die anfragende Person zu warnen. Ist der
               Aktivitätsstrom nicht eingerichtet oder eine Meldung verloren
               gegangen, ist DAS der zweite Weg, auf dem wir es erfahren.
               Gestempelt wird nur, was noch niemand weiss. */
            if (row.documentOutdated && !doc.feedRevisedAt) {
                data.feedRevisedAt = new Date();
                data.feedRevisedSource = 'OSP_DOCUMENT_OUTDATED';
            }
            const salesmanEmail = asTrimmed(row.salesman?.email as string | undefined);
            if (salesmanEmail && !doc.salespersonEmail) {
                data.salespersonEmail = salesmanEmail;
                data.salespersonName = [row.salesman?.name, row.salesman?.surname].filter(Boolean).join(' ') || doc.salespersonName;
                // Die Karte, die die OSP führt — inklusive Rufnummer und Bild,
                // sofern die Adresse drüben ein Konto hat.
                data.salespersonProfile = { ...row.salesman, email: salesmanEmail } as any;
            }
            if (Object.keys(data).length) {
                await (prisma as any).ospDocument.update({ where: { id: doc.id }, data });
                updated += 1;
            }
        }

        res.json({ checked: docs.length, updated, failed });
    } catch (error: any) {
        res.status(500).json({ error: error?.message || 'OSP-Abgleich fehlgeschlagen.' });
    }
});

/* ── 6) Einstellungen (Einstellungen → Module → Verkauf → OSP) ───────────── */

router.get('/settings', requireAuth, requireAnyPermission(SETTINGS_MANAGE), async (req, res) => {
    try {
        const tenantId = (req as any).user!.tenantId;
        const rootId = await findTenantRootIdCached(tenantId);
        if (!rootId) return res.status(403).json({ error: 'Kein aktiver Firmenbaum.' });
        const setting = await (prisma as any).ospSetting.findUnique({ where: { tenantId: rootId } });
        res.json({
            rootTenantId: rootId,
            tenantIds: parseTenantIds(setting?.tenantIds),
            webhookKey: setting?.webhookKey || '',
            ospBaseUrl: setting?.ospBaseUrl || '',
            hasApiKey: Boolean(asTrimmed(setting?.ospApiKey)),
            // Die drei Adressen, die der OSP zu nennen sind — relativ; die
            // Oberfläche stellt den eigenen Ursprung davor. Getrennt, damit
            // drüben auf die Adresse geroutet werden kann statt auf den Inhalt.
            ...OSP_WEBHOOK_PATHS,
        });
    } catch (error: any) {
        res.status(500).json({ error: error?.message || 'OSP-Einstellungen fehlgeschlagen.' });
    }
});

router.put('/settings', requireAuth, requireAnyPermission(SETTINGS_MANAGE), async (req, res) => {
    try {
        const tenantId = (req as any).user!.tenantId;
        const rootId = await findTenantRootIdCached(tenantId);
        if (!rootId) return res.status(403).json({ error: 'Kein aktiver Firmenbaum.' });

        const body = req.body || {};
        const data: any = {};

        if (body.tenantIds !== undefined) {
            const requested = parseTenantIds(body.tenantIds);
            const treeIds = new Set(collectDescendantIds(await getAllTenants(), rootId));
            data.tenantIds = requested.filter((id) => treeIds.has(id));
        }
        if (body.webhookKey !== undefined) data.webhookKey = asTrimmed(body.webhookKey);
        if (body.ospBaseUrl !== undefined) data.ospBaseUrl = asTrimmed(body.ospBaseUrl);
        // Schlüssel wie beim Mailkonto: leer = behalten, null = löschen.
        if (body.ospApiKey === null) data.ospApiKey = null;
        else if (asTrimmed(body.ospApiKey)) data.ospApiKey = asTrimmed(body.ospApiKey);

        const setting = await (prisma as any).ospSetting.upsert({
            where: { tenantId: rootId },
            create: { id: nanoid(12), tenantId: rootId, ...data },
            update: data,
        });

        res.json({
            rootTenantId: rootId,
            tenantIds: parseTenantIds(setting.tenantIds),
            webhookKey: setting.webhookKey || '',
            ospBaseUrl: setting.ospBaseUrl || '',
            hasApiKey: Boolean(asTrimmed(setting.ospApiKey)),
            ...OSP_WEBHOOK_PATHS,
        });
    } catch (error: any) {
        res.status(500).json({ error: error?.message || 'OSP-Einstellungen konnten nicht gespeichert werden.' });
    }
});

export default router;
