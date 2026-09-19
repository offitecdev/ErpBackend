"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DOCUMENT_ACTION_PERMISSION_NAMES = exports.DOCUMENT_ACTION_PERMISSIONS = void 0;
/**
 * ── WER DARF EINEN BELEG ZURÜCKNEHMEN? (16.09.2026, Schritt 4 / D2 + D3) ─────
 *
 * Die Rücknahmen hingen bisher an den allgemeinen Verwaltungsrechten — wer ein
 * Projekt bearbeiten durfte, durfte auch jeden Auftrag darin zurücksetzen. Jetzt
 * hat jede Rücknahme ihr EIGENES Recht; es steht auf Stufe 3 der jeweiligen
 * Seite (shared/pageCatalog.ts), die Rollentabelle schaltet es also wie jedes
 * andere Recht.
 *
 * Zwei Handlungen tragen gar kein Recht, sondern verlangen die
 * Administratorrolle (`Role.isSystemAdmin`):
 *   • ein Storno AUFHEBEN — ein zurückgenommener Beleg lebt wieder;
 *   • eine Sperre bewusst ÜBERSCHREITEN (siehe override.ts).
 *
 * Diese Datei ist die EINE Stelle, an der die Zuordnung steht; Routen und
 * Oberfläche lesen sie von hier (die Oberfläche über ihre Spiegelkopie
 * src/components/governance/governance.ts).
 */
exports.DOCUMENT_ACTION_PERMISSIONS = {
    TENDER_CANCEL: 'tenders.cancel',
    ORDER_CANCEL: 'salesOrders.cancel',
    ORDER_REVERT: 'salesOrders.revert',
    PROJECT_CANCEL: 'projects.cancel',
    INVOICE_CANCEL: 'invoices.cancel',
};
/** Alle Rechtenamen dieses Moduls — für Katalog und Prüfungen. */
exports.DOCUMENT_ACTION_PERMISSION_NAMES = Object.values(exports.DOCUMENT_ACTION_PERMISSIONS);
//# sourceMappingURL=permissions.js.map