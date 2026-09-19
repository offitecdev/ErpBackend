"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
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
__exportStar(require("./permissions"), exports);
__exportStar(require("./events"), exports);
__exportStar(require("./history"), exports);
__exportStar(require("./override"), exports);
//# sourceMappingURL=index.js.map