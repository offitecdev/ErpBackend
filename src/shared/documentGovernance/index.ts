/**
 * ── BELEGAUFSICHT (16.09.2026, Schritt 4) ───────────────────────────────────
 *
 * Ein Modul, vier Teile — jeder in seiner Datei, jeder für sich verwendbar:
 *
 *   permissions.ts  WER darf zurücknehmen (eigene Rechte je Handlung)
 *   events.ts       Verlaufseintrag SCHREIBEN (in der Transaktion der Handlung)
 *   history.ts      Verlauf LESEN (eigene + verweisende Einträge)
 *   override.ts     die AUSNAHMETÜR der Systemverwaltung (Politik + Prüfung)
 *
 * Die Middleware `requireSystemAdmin` (presentation/middlewares) und die
 * Route `/document-events` bauen darauf auf.
 */
export * from './permissions';
export * from './events';
export * from './history';
export * from './override';
