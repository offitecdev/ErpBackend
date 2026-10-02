"use strict";
/**
 * ── GÖREVLENDİRME DER PRODUKTION (26.09.2026, Vorgabe Samet) ────────────────
 *
 * «Üretim bölümlere ayrılıyor — Mekanik ve Elektrik … mekanikte cihaz seçimi
 *  başa, ama görevlendirme en başta … elektrikte devre tasarımı.»
 *
 * Ein Gerät durchläuft seine Stufen zweimal nebeneinander: einmal im Bereich
 * MECHANICAL (Mekanik), einmal im Bereich ELECTRICAL (Elektrik). Jede Aufgabe
 * gehört zu genau einem Bereich und genau einer Stufe; ihr Gewicht zählt
 * innerhalb des Bereichs, der Bereich trägt seinen Anteil zur
 * Gesamtfertigstellung bei (Chiller: 60 / 40).
 *
 * EIGENE BEREICHE UND STUFEN (28.09.2026): «when the user creates new template
 * they should create the sections manually, but keep the existing templates …
 * also stages should be created dynamically.» Eine Vorlage bringt ihre Bereiche
 * mit — Name, Anteil und die Stufen in der Reihenfolge des Weges. Mekanik und
 * Elektrik bleiben als FESTE Bereiche der Vorlagen von vorher: nur sie kennen
 * die BOM-Stufe und tragen ihre Namen aus der Übersetzung.
 *
 * Die Zuweisungen selbst sind keine Stufe mit Aufgaben — sie stehen vor dem
 * Weg («görevlendirme en başta»), darum kommen hier nur die Arbeitsstufen vor.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PRODUCTION_UI_LANGUAGES = void 0;
exports.PRODUCTION_UI_LANGUAGES = ['tr', 'en', 'de'];
//# sourceMappingURL=ProductionTask.js.map