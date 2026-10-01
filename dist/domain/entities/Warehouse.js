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
exports.WAREHOUSE_BOM_AREAS = exports.WAREHOUSE_UNITS = exports.WAREHOUSE_CURRENCIES = void 0;
/** Dieselbe Liste wie die Offerte (Frontend utils/currency.ts). */
exports.WAREHOUSE_CURRENCIES = ['CHF', 'EUR', 'USD', 'GBP', 'TRY'];
/**
 * Die Einheit einer Karte (30.09.2026, Samet: «her ürünün de birim türü
 * olmalıdır — adet, uzunluk … bom listede vardı, oraya otomatik gelmesi
 * gerekmektedir»). Dieselbe Liste wie die BOM-Zeile (BOM_UNITS) — das Depo
 * importiert die BOM nicht, darum hier gespiegelt.
 */
exports.WAREHOUSE_UNITS = ['PCS', 'M', 'KG', 'SET', 'PACK'];
/**
 * Der BOM-Bereich einer Hauptkategorie (01.10.2026, Samet: «bomda mekanik olan
 * sadece kendi MAK kodlarını görebilecek … her kod türü, bu kod türlerine de
 * alan atama olacak: mekanik, elektrik ve ikisi de»). Die BOM-Suche eines
 * Bereichs zeigt nur Karten aus Kategorien dieses Bereichs oder BOTH.
 */
exports.WAREHOUSE_BOM_AREAS = ['MECHANICAL', 'ELECTRICAL', 'BOTH'];
//# sourceMappingURL=Warehouse.js.map