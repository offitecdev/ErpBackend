"use strict";
/**
 * KALENDER-ETIKETTEN — die Liste, aus der ein Kalendereintrag seine Farbe
 * bekommt (25.08.2026, Vorgabe Samet).
 *
 * Bis hierher stand die Farbe einer Karte NICHT zur Wahl: der Kalender las die
 * Uhr und färbte danach. Jetzt wird das Etikett GEWÄHLT — und die Liste steht
 * von Anfang an richtig da: je ROLLE ein Etikett, jedes mit seiner eigenen
 * Farbe. Es sind genau die Farben, die die Karten dieses Standes bisher schon
 * trugen; der Kalender sieht deshalb aus wie vorher, nur ist die Farbe jetzt
 * eine Angabe am Eintrag und keine Rechnung mehr.
 *
 * Ein Etikett ist vier Dinge:
 *   `name`   — wie es in der Leiste und auf der Karte heisst,
 *   `color`  — #rrggbb, die Fläche der Karte,
 *   `role`   — WOFÜR es gedacht ist,
 *   `hidden` — weggeräumt, aber nicht weggeworfen.
 *
 * Die ROLLE sperrt nichts: jedes Etikett lässt sich an jeden Eintrag hängen.
 * Sie sagt, was beim Anlegen VORGESCHLAGEN wird — und welche Rolle im «+»
 * noch frei ist: je Rolle steht EIN sichtbares Etikett. Wird es ausgeblendet,
 * ist die Rolle wieder frei und lässt sich neu vergeben.
 *
 * Aufgaben haben bewusst keine Rolle — sie stehen nicht mehr im Raster.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeLabelName = exports.normalizeLabelColor = exports.normalizeLabelRole = exports.FALLBACK_LABEL_COLOR = exports.CALENDAR_LABEL_ROLES = exports.DEFAULT_CALENDAR_LABELS = exports.MAX_LABEL_NAME_LENGTH = void 0;
exports.MAX_LABEL_NAME_LENGTH = 60;
/**
 * Der Erstbestand je Mandant — dieselben vier Zeilen, die auch die Migration
 * `20260901100000_calendar_label_roles` anlegt. Ein NEU angelegter Mandant
 * bekommt sie beim ersten Aufruf der Liste.
 *
 * Die Farben sind die Kalenderpalette, die die Anwendung schon immer benutzt
 * hat: Peacock für das, was bevorsteht, Blueberry für das, was läuft, Basil
 * für das, was vorbei ist, Grape für die Besprechung.
 */
exports.DEFAULT_CALENDAR_LABELS = [
    { role: 'PLANNED', name: 'Geplanter Termin', color: '#039be5', sortOrder: 10 },
    { role: 'ONGOING', name: 'Laufender Termin', color: '#3f51b5', sortOrder: 20 },
    { role: 'DONE', name: 'Abgeschlossener Termin', color: '#0b8043', sortOrder: 30 },
    { role: 'MEETING', name: 'Besprechung', color: '#8e24aa', sortOrder: 40 },
];
exports.CALENDAR_LABEL_ROLES = exports.DEFAULT_CALENDAR_LABELS.map((seed) => seed.role);
/** Die Farbe, mit der ein Etikett ohne Rolle startet. */
exports.FALLBACK_LABEL_COLOR = '#d93025';
/**
 * Eine Rolle aus einem Anfragekörper. Unbekanntes und Leeres wird `null` —
 * ein Etikett ohne Rolle ist gültig (es färbt dann nur).
 */
const normalizeLabelRole = (value) => {
    const raw = String(value ?? '').trim().toUpperCase();
    return exports.CALENDAR_LABEL_ROLES.includes(raw) ? raw : null;
};
exports.normalizeLabelRole = normalizeLabelRole;
/**
 * Eine Farbe auf die Schreibweise bringen, die gespeichert wird: `#rrggbb`,
 * klein. Kurzform (`#abc`) wird ausgeschrieben; alles andere ist keine Farbe.
 */
const normalizeLabelColor = (value) => {
    const raw = String(value ?? '').trim().toLowerCase();
    if (/^#[0-9a-f]{6}$/.test(raw))
        return raw;
    if (/^#[0-9a-f]{3}$/.test(raw))
        return `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`;
    return null;
};
exports.normalizeLabelColor = normalizeLabelColor;
/** Der Name, wie er gespeichert wird — getrimmt und auf die Feldlänge gekürzt. */
const normalizeLabelName = (value) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, exports.MAX_LABEL_NAME_LENGTH);
exports.normalizeLabelName = normalizeLabelName;
//# sourceMappingURL=calendarLabels.js.map