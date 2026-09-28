"use strict";
/**
 * ── DEPO — DAS LAGER DER PRODUKTIONSFIRMA (26.09.2026, Vorgabe Samet) ────────
 *
 * «Stok modülünü bozmuyoruz. Ek olarak depo modülü yazıyoruz. Depo modülü
 *  sadece üretim modülü ile ilişkili olması gerekir.»
 *
 * Ein eigenes Lager neben dem Artikellager (Article/StockBalance bleiben
 * unberührt), nur in Firmen mit `companyType = PRODUCTION`. Die erste Seite
 * sind die Produktkarten; Pflicht ist allein der Name.
 *
 * Zweiter Durchgang (am selben Tag): Hauptkategorien mit Kürzel (Elektrik =
 * ELK), Materialgruppen mit Kürzel (PLC), der ERP-Code je Gruppe
 * (ELK-PLC-00001), ein GS1-Barcode je Karte, Etiketten und der Excel-Aktarım
 * mit Freigabe durch die Verwaltung.
 *
 * Tabellen: `depo_*` (prisma/schema/warehouse.prisma).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.WAREHOUSE_CURRENCIES = void 0;
/** Dieselbe Liste wie die Offerte (Frontend utils/currency.ts). */
exports.WAREHOUSE_CURRENCIES = ['CHF', 'EUR', 'USD', 'GBP', 'TRY'];
//# sourceMappingURL=Warehouse.js.map