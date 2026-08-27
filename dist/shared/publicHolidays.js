"use strict";
/**
 * ── AMTLICHE FEIERTAGE (26.08.2026, Vorgabe Samet) ───────────────────────────
 *
 * «Feiertage, etwa religiöse Feste, sollen erfasst werden; alle amtlichen
 * Feiertage der Türkei sollen aufgelistet sein, einer davon lässt sich
 * auswählen.»
 *
 * DER KATALOG IST KEIN BESTAND. Er ist eine VORSCHLAGSLISTE: was das Haus
 * tatsächlich führt, steht in `PublicHoliday` — dort, wo es der Verwaltung
 * gehört, umbenennbar, verschiebbar und löschbar. Der Katalog rechnet nur
 * aus, welche Tage ein bestimmtes Jahr amtlich kennt.
 *
 * DIE FESTEN TAGE stehen im Sonnenkalender und sind darum aus Monat und Tag
 * gerechnet. DIE RELIGIÖSEN FESTE (Ramazan und Kurban) folgen dem Mondjahr und
 * wandern rund elf Tage im Jahr nach vorn; sie lassen sich nicht aus einer
 * Formel ableiten, ohne der Diyanet zu widersprechen. Sie stehen deshalb als
 * TABELLE des ersten Festtages je Jahr da — und weil eine Tabelle irren kann,
 * ist jedes Datum beim Übernehmen noch änderbar.
 *
 * DIE NAMEN reisen in drei Sprachen mit. Gespeichert wird EIN Name (er ist
 * dann Bestand, kein Oberflächentext); welcher, entscheidet die Sprache, in
 * der die Verwaltung den Tag übernimmt.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.holidayCatalogYears = exports.holidayCatalog = exports.HOLIDAY_COUNTRIES = void 0;
exports.HOLIDAY_COUNTRIES = ['TR'];
/** Die festen Tage des türkischen Kalenders: Monat (1-12) und Tag. */
const FIXED_TR = [
    {
        key: 'tr.newYear', month: 1, day: 1,
        names: { tr: 'Yılbaşı', de: 'Neujahr', en: 'New Year' },
    },
    {
        key: 'tr.sovereignty', month: 4, day: 23,
        names: {
            tr: 'Ulusal Egemenlik ve Çocuk Bayramı',
            de: 'Tag der nationalen Souveränität und des Kindes',
            en: 'National Sovereignty and Children’s Day',
        },
    },
    {
        key: 'tr.labour', month: 5, day: 1,
        names: {
            tr: 'Emek ve Dayanışma Günü',
            de: 'Tag der Arbeit und der Solidarität',
            en: 'Labour and Solidarity Day',
        },
    },
    {
        key: 'tr.youth', month: 5, day: 19,
        names: {
            tr: 'Atatürk’ü Anma, Gençlik ve Spor Bayramı',
            de: 'Atatürk-Gedenktag, Jugend- und Sportfest',
            en: 'Commemoration of Atatürk, Youth and Sports Day',
        },
    },
    {
        key: 'tr.democracy', month: 7, day: 15,
        names: {
            tr: 'Demokrasi ve Millî Birlik Günü',
            de: 'Tag der Demokratie und der nationalen Einheit',
            en: 'Democracy and National Unity Day',
        },
    },
    {
        key: 'tr.victory', month: 8, day: 30,
        names: { tr: 'Zafer Bayramı', de: 'Tag des Sieges', en: 'Victory Day' },
    },
    {
        // Der Nachmittag des 28. Oktober ist amtlich arbeitsfrei — ein halber Tag.
        key: 'tr.republic.eve', month: 10, day: 28, halfDay: true,
        names: {
            tr: 'Cumhuriyet Bayramı Arifesi',
            de: 'Vorabend des Tages der Republik',
            en: 'Republic Day Eve',
        },
    },
    {
        key: 'tr.republic', month: 10, day: 29,
        names: { tr: 'Cumhuriyet Bayramı', de: 'Tag der Republik', en: 'Republic Day' },
    },
];
/**
 * Der ERSTE Festtag je Jahr (Diyanet-Kalender). Die Arife ist der Tag davor,
 * die weiteren Festtage folgen unmittelbar.
 *
 * Fehlt ein Jahr, führt der Katalog für dieses Jahr keine religiösen Feste —
 * geraten wird nicht. Die Verwaltung trägt sie dann von Hand ein, und die
 * Tabelle wird beim nächsten Mal ergänzt.
 */
const RAMAZAN_FIRST_DAY = {
    2024: '2024-04-10',
    2025: '2025-03-30',
    2026: '2026-03-20',
    2027: '2027-03-09',
    2028: '2028-02-26',
    2029: '2029-02-14',
    2030: '2030-02-04',
    2031: '2031-01-24',
    2032: '2032-01-14',
};
const KURBAN_FIRST_DAY = {
    2024: '2024-06-16',
    2025: '2025-06-06',
    2026: '2026-05-27',
    2027: '2027-05-16',
    2028: '2028-05-05',
    2029: '2029-04-24',
    2030: '2030-04-13',
    2031: '2031-04-02',
    2032: '2032-03-22',
};
const pad = (value) => String(value).padStart(2, '0');
const isoOf = (year, month, day) => `${year}-${pad(month)}-${pad(day)}`;
/** Kalendertag + n Tage, wieder als ISO-Text. Rechnet in UTC, damit keine
    Sommerzeitumstellung einen Tag verschluckt. */
const shiftIso = (iso, days) => {
    const [year, month, day] = iso.split('-').map(Number);
    const base = Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1);
    return new Date(base + days * 86_400_000).toISOString().slice(0, 10);
};
/** Ein religiöses Fest: Arife (halber Tag) + `length` volle Festtage. */
const feast = (prefix, firstDay, length, names, eveNames) => {
    const rows = [{
            key: `${prefix}.eve`,
            date: shiftIso(firstDay, -1),
            names: eveNames,
            religious: true,
            halfDay: true,
        }];
    for (let index = 0; index < length; index += 1) {
        rows.push({
            key: `${prefix}.d${index + 1}`,
            date: shiftIso(firstDay, index),
            names: {
                tr: `${names.tr} ${index + 1}. Gün`,
                de: `${names.de} — ${index + 1}. Tag`,
                en: `${names.en} — day ${index + 1}`,
            },
            religious: true,
            halfDay: false,
        });
    }
    return rows;
};
/**
 * Alle amtlichen Feiertage eines Jahres, nach Datum sortiert.
 * Unbekanntes Land oder unmögliches Jahr → leere Liste (kein Fehler: der
 * Katalog ist ein Vorschlag, kein Vertrag).
 */
const holidayCatalog = (year, country = 'TR') => {
    if (country !== 'TR')
        return [];
    if (!Number.isInteger(year) || year < 1990 || year > 2100)
        return [];
    const rows = FIXED_TR.map((entry) => ({
        key: entry.key,
        date: isoOf(year, entry.month, entry.day),
        names: entry.names,
        religious: false,
        halfDay: Boolean(entry.halfDay),
    }));
    const ramazan = RAMAZAN_FIRST_DAY[year];
    if (ramazan) {
        rows.push(...feast('tr.ramazan', ramazan, 3, { tr: 'Ramazan Bayramı', de: 'Ramazan-Fest', en: 'Ramadan Feast' }, { tr: 'Ramazan Bayramı Arifesi', de: 'Ramazan-Fest, Vorabend', en: 'Ramadan Feast Eve' }));
    }
    const kurban = KURBAN_FIRST_DAY[year];
    if (kurban) {
        rows.push(...feast('tr.kurban', kurban, 4, { tr: 'Kurban Bayramı', de: 'Opferfest', en: 'Feast of Sacrifice' }, { tr: 'Kurban Bayramı Arifesi', de: 'Opferfest, Vorabend', en: 'Feast of Sacrifice Eve' }));
    }
    return rows.sort((a, b) => a.date.localeCompare(b.date));
};
exports.holidayCatalog = holidayCatalog;
/** Die Jahre, für die der Katalog auch die religiösen Feste kennt. */
const holidayCatalogYears = () => Object.keys(RAMAZAN_FIRST_DAY).map(Number).sort((a, b) => a - b);
exports.holidayCatalogYears = holidayCatalogYears;
//# sourceMappingURL=publicHolidays.js.map