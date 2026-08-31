"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.employeeScopeSql = exports.isEmployeeInScope = exports.employeeScopeWhere = exports.isTenantInServiceTenantScope = void 0;
exports.getServiceTenantScope = getServiceTenantScope;
exports.getPersonnelTenantScope = getPersonnelTenantScope;
exports.getCompanyTreeTenantIds = getCompanyTreeTenantIds;
exports.getMailTenantId = getMailTenantId;
exports.getCustomerInServiceTenantScope = getCustomerInServiceTenantScope;
exports.getAssignableTenantIds = getAssignableTenantIds;
const client_1 = require("@prisma/client");
const prisma_client_1 = __importDefault(require("../../infrastructure/database/prisma.client"));
const tenantAccess_1 = require("../utils/tenantAccess");
const tenantTree_1 = require("../../shared/tenantTree");
// Tenant tablosu artık istek başına değil, paylaşılan önbellekten okunuyor —
// aşağıdaki iki yardımcı her CRM/servis isteğinde çağrıldığı için bu tek başına
// istek başına ~170 ms'lik bir ağ turunu kaldırıyor.
const getDescendantTenantIds = tenantTree_1.collectDescendantIds;
async function getServiceTenantScope(selectedTenantId) {
    const tenants = await (0, tenantTree_1.getAllTenants)();
    const selectedTenant = tenants.find((tenant) => tenant.id === selectedTenantId);
    if (!selectedTenant?.isActive)
        return [];
    if (selectedTenant.parentTenantId)
        return [selectedTenant.id];
    return getDescendantTenantIds(tenants.filter((tenant) => tenant.isActive), selectedTenant.id);
}
/**
 * Personal-Bereich — die Firmen, aus denen eine PERSONENLISTE gespeist wird.
 *
 * Seit dem 31.08.2026 ist Personal NICHT mehr firmenbaumweit geteilt: eine
 * Person gehört genau der Firma, unter der sie angelegt wurde, und taucht
 * nirgendwo sonst auf — auch nicht in der Muttergesellschaft. Damit sehen
 * Untergesellschaften einander nicht mehr in Auswahlfenstern (Rehberler,
 * Techniker-Auswahl, CC-Listen, Mail-Kategorien).
 *
 * Wer WELCHE Firma auswählen darf, ist eine andere Frage: das entscheidet
 * `Employee.allowedTenantIds` in `AuthMiddleware.resolveTenantId` und
 * `TenantController.list`. Diese Funktion beantwortet nur: "welche Firma wird
 * gerade angeschaut" — und das ist genau die ausgewählte.
 *
 * Der ganze Baum (`getCompanyTreeTenantIds`) bleibt für die Dinge, die
 * baumweit sind: Rollen/Rollenvorlagen, die Prüfung einer Firmenzuteilung und
 * das Erkennen eigener Mitarbeiteradressen im Postfach.
 */
async function getPersonnelTenantScope(selectedTenantId) {
    const tenants = await (0, tenantTree_1.getAllTenants)();
    const selected = tenants.find((tenant) => tenant.id === selectedTenantId);
    return selected?.isActive ? [selected.id] : [];
}
/**
 * Every active tenant id in the caller's company tree (root + all
 * descendants), no matter which tenant is selected.
 *
 * NOT for staff listings any more — see getPersonnelTenantScope. What is still
 * tree-wide: roles and role templates (they are created on the root and only
 * their module package is per entity), validating a company assignment
 * (`allowedTenantIds` may narrow the tree, never leave it) and recognising our
 * own employees' e-mail addresses in the shared root mailbox.
 */
async function getCompanyTreeTenantIds(selectedTenantId) {
    const tenants = await (0, tenantTree_1.getAllTenants)();
    const byId = new Map(tenants.map((tenant) => [tenant.id, tenant]));
    let current = byId.get(selectedTenantId);
    if (!current?.isActive)
        return [];
    for (let depth = 0; current.parentTenantId && depth < 20; depth += 1) {
        const parent = byId.get(current.parentTenantId);
        if (!parent?.isActive)
            return [];
        current = parent;
    }
    return getDescendantTenantIds(tenants.filter((tenant) => tenant.isActive), current.id);
}
/* ── EIN POSTFACH JE FIRMENBAUM ──────────────────────────────────────────────
 *
 * Vorgabe Samet: «alle Mails an den Hauptmandanten hängen; in Untermandanten
 * darf es für persönliche Post keine Trennung geben». Jede mailförmige Zeile —
 * `MailMessage`, `MailCategory`, `MailSetting` samt der IMAP-Lesestände —
 * gehört darum dem STAMM des Firmenbaums, nicht der gerade ausgewählten Firma.
 * Wer den Mandanten wechselt, wechselt nicht das Postfach.
 *
 * Ohne diese Auflösung entsteht genau der Schaden, der am 30.08.2026 zu sehen
 * war: dieselben IMAP-Zugangsdaten standen in ZWEI Mandanten desselben Baums,
 * also holten zwei Abrufe dasselbe Serverpostfach in zwei getrennte Bestände —
 * und weil jeder Abruf NUR VORWÄRTS liest (siehe ImapCaptureService), stand im
 * zweiten Bestand nur, was seit seinem Beginn ankam: 45 Nachrichten statt
 * 2800. Ein Zurücksetzen des Lesestands heilt das nicht, es verdoppelt bloss
 * die Arbeit — geheilt ist es erst, wenn beide Seiten DENSELBEN Bestand lesen.
 *
 * Gegenstück: die Datensätze, auf die eine Mail ZEIGT (Kunde, Ansprech-
 * partner, Angebot, Auftrag, Projekt, Rechnung), bleiben in ihrer eigenen
 * Firma. Sie werden über `getCompanyTreeTenantIds` gesucht — nie über den
 * Mail-Mandanten, sonst fände ein am Stamm hängendes Postfach die Kundschaft
 * der Untergesellschaften nicht mehr wieder.
 *
 * Ist ein Mandant der Kette abgeschaltet, bleibt es bei der übergebenen Firma:
 * Post darf nirgendwo landen, wo sie niemand mehr sieht.
 */
async function getMailTenantId(selectedTenantId) {
    return (await (0, tenantTree_1.findTenantRootIdCached)(selectedTenantId)) || selectedTenantId;
}
async function getCustomerInServiceTenantScope(customerId, selectedTenantId) {
    const tenantIds = await getServiceTenantScope(selectedTenantId);
    return prisma_client_1.default.customer.findFirst({
        where: {
            id: customerId,
            tenantId: { in: tenantIds },
        },
        select: {
            id: true,
            tenantId: true,
        },
    });
}
const isTenantInServiceTenantScope = async (tenantId, selectedTenantId) => {
    const tenantIds = await getServiceTenantScope(selectedTenantId);
    return tenantIds.includes(tenantId);
};
exports.isTenantInServiceTenantScope = isTenantInServiceTenantScope;
/* ── ZU WELCHER FIRMA GEHÖRT EINE PERSON? ────────────────────────────────────
 *
 * Zu der, unter der sie ANGELEGT wurde (`Employee.tenantId`) — und zu jeder,
 * die ihr in der Firmenzuteilung ausdrücklich angehakt wurde
 * (`Employee.allowedTenantIds`, Personal → Person → Zugang). Nichts sonst.
 * Ohne Zuteilung bleibt es bei der einen eigenen Firma; genau das trennt die
 * Mannschaften der Untergesellschaften voneinander.
 *
 * Die Zuteilung ist damit beides in einem: sie öffnet den Firmenumschalter
 * (AuthMiddleware) UND stellt die Person in die Liste der zweiten Firma. Wäre
 * sie nur das erste, könnte sich eine Verwaltung aussperren: zugeteilt auf
 * eine Firma, in der sie selbst nicht steht, sähe sie dort niemanden — auch
 * sich selbst nicht — und käme nie wieder an ihre eigene Zuteilung heran.
 *
 * Zwei Ausprägungen derselben Regel: eine für die Prisma-Abfragen, eine für
 * die $queryRaw-Listen. Sie müssen im Gleichschritt bleiben.
 */
/**
 * Die Firmen, die eine Verwaltung ZUTEILEN darf — und damit zugleich die
 * Firmenliste, die die Zugangsfläche (Personal → Person → Zugang) anzeigt.
 *
 * ── JEDE AKTIVE FIRMA (Vorgabe 31.08.2026) ──────────────────────────────────
 * «Eine Auswahl muss getroffen werden, sie muss angegeben werden. Die
 * Verwaltung muss wissen, wer was auswählen kann und was in der Liste steht —
 * unabhängig davon, ob es eine Untergesellschaft ist oder nicht.»
 *
 * Vorher stand hier der eigene TEILBAUM: die ausgewählte Firma mit ihren
 * Untergesellschaften plus derselbe Teilbaum der Heimatfirma. Das hatte zwei
 * Folgen, die beide falsch waren:
 *
 *  • Wer als Verwaltung gerade auf einer Untergesellschaft stand (etwa
 *    «Offitec GmbH», die selbst keine Töchter hat), bekam auf der
 *    Zugangsfläche GENAU EINE Firma angeboten und konnte gar nichts zuteilen.
 *  • Eine zweite Firmengruppe (ein Tenant ohne Elternfirma, wie «OFFITEC
 *    Merkez») war überhaupt nicht zuteilbar — obwohl sie in derselben
 *    Anwendung steht und dieselbe Verwaltung sie führt.
 *
 * Die Grenze ist damit nicht mehr die Form des Baums, sondern die AUSDRÜCKLICHE
 * Zuteilung: sichtbar wird eine Firma erst, wenn sie hier angehakt wurde. Wer
 * die Zugangsfläche überhaupt öffnen darf, entscheidet weiterhin
 * `requirePermission('roles.manage')` — das trägt nur die Administratorrolle.
 *
 * Die beiden Argumente bleiben in der Signatur: jede Aufrufstelle nennt damit
 * weiterhin, WER zuteilt, und eine spätere Einschränkung (etwa «nur die eigene
 * Gruppe, ausser der Stamm») braucht keine Umbauten an den Aufrufen.
 */
async function getAssignableTenantIds(_selectedTenantId, _homeTenantId) {
    const tenants = await (0, tenantTree_1.getAllTenants)();
    return tenants.filter((tenant) => tenant.isActive).map((tenant) => tenant.id);
}
/** Prisma-Bedingung. Zum Hineinstreuen: `where: { id, ...employeeScopeWhere(ids), deletedAt: null }`. */
const employeeScopeWhere = (tenantIds) => ({
    // AND/OR statt eines nackten OR: die Aufrufstellen tragen oft schon ein
    // eigenes OR (Rollen-, Namenssuche), das sonst überschrieben würde.
    AND: [{
            OR: [
                { tenantId: { in: tenantIds } },
                ...tenantIds.map((tenantId) => ({ allowedTenantIds: { array_contains: tenantId } })),
            ],
        }],
});
exports.employeeScopeWhere = employeeScopeWhere;
/** Dieselbe Regel auf einer BEREITS GELADENEN Zeile — für die
    Eigentumsprüfungen, die den Datensatz ohnehin schon in der Hand haben. */
const isEmployeeInScope = (employee, tenantIds) => tenantIds.includes(employee.tenantId)
    || ((0, tenantAccess_1.parseAllowedTenantIds)(employee.allowedTenantIds) ?? []).some((tenantId) => tenantIds.includes(tenantId));
exports.isEmployeeInScope = isEmployeeInScope;
/** Dieselbe Bedingung für rohes SQL; `alias` ist der Tabellenname der Abfrage. */
const employeeScopeSql = (tenantIds, alias = 'e') => {
    if (!tenantIds.length)
        return client_1.Prisma.sql `1 = 0`;
    // `alias` steht in jedem Aufruf als Buchstabe im Quelltext — nie aus einer
    // Anfrage; nur deshalb darf er als Prisma.raw in die Abfrage.
    const table = client_1.Prisma.raw(alias);
    const assigned = tenantIds.map((tenantId) => client_1.Prisma.sql `JSON_CONTAINS(COALESCE(${table}.allowedTenantIds, JSON_ARRAY()), JSON_QUOTE(${tenantId}))`);
    return client_1.Prisma.sql `(${table}.tenantId IN (${client_1.Prisma.join(tenantIds)}) OR ${client_1.Prisma.join(assigned, ' OR ')})`;
};
exports.employeeScopeSql = employeeScopeSql;
//# sourceMappingURL=serviceTenantScope.js.map