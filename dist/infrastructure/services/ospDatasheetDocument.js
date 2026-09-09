"use strict";
/**
 * ── DAS DATENBLATT ALS DOKUMENT (20.09.2026) ────────────────────────────────
 *
 * Ein OSP-Datenblatt ist kein Fliesstext, sondern ein AUFGEBAUTES Blatt:
 * Abschnittsüberschriften, darunter Zeilen der Form `Bezeichnung [Einheit]
 * Wert`.
 *
 *     Unit Technical Specifications
 *     Refrigerant - R290
 *     Evaporator Type Type Plate Type
 *     Cooling Capacity kW 82.32
 *
 * Bis hierher wurde daraus mit Suchmustern über den ganzen Text gelesen — und
 * das ging schief, sobald dasselbe Wort auch im Fliesstext vorkam. Aus dem
 * Hinweissatz «differing medium concentrations …» wurde so das Medium
 * „concentrations", und genau das stand danach auf der Offerte.
 *
 * Deshalb hier ZWEI Schritte statt einem:
 *
 *  1. `parseDatasheetDocument()` macht aus dem Text ein Dokument: Abschnitte,
 *     ZEILEN (Bezeichnung/Einheit/Wert) und Fliesstext getrennt. Der laufende
 *     Kopf ("… Page 3 / 7") fällt weg.
 *  2. Gelesen wird danach nur noch aus den ZEILEN, über ihre Bezeichnung. Ein
 *     Hinweissatz kann keine Angabe mehr liefern, weil er gar keine Zeile ist.
 *
 * Und weil dasselbe Dokument sich als Markdown schreiben lässt, ist das
 * zugleich die lesbare Fassung des Datenblatts: `buildDatasheetMarkdown()`
 * stellt die erkannten Produktangaben nach oben und lässt das ganze Blatt
 * darunter stehen — nichts geht verloren, und man sieht, woher eine Angabe
 * kommt.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseMarkdownDocument = exports.buildDatasheetMarkdown = exports.specsFromDocument = exports.parseDatasheetDocument = void 0;
/* ── 1) Text → Dokument ─────────────────────────────────────────────────── */
/** Der laufende Kopf jeder Seite — er gehört nicht zum Inhalt. */
const RUNNING_HEAD = /^.{0,80}?Page\s+\d+\s*\/\s*\d+\s*$/i;
/**
 * Die Einheiten, die ein Datenblatt führt. Sie stehen ZWISCHEN Bezeichnung und
 * Wert ("Cooling Capacity **kW** 82.32") und sind damit der verlässlichste
 * Schnittpunkt der Zeile. `-` und `Type` sind Platzhalter der OSP für „ohne
 * Einheit" und werden wie eine Einheit behandelt.
 */
const UNIT_TOKENS = [
    'kcal/h', 'kWh', 'kW', 'kg', 'mm', 'cm', 'm³/h', 'm3/h', 'm²', 'm2',
    'dB(A)', 'dB', '°C', 'K', 'bar', 'kPa', 'Pa', 'Hz', 'A', 'V', 'W',
    'l/s', 'l/h', '%', 'n', 'Type', '-',
];
/**
 * Die Bezeichnungen, die ein OSP-Blatt führt — Englisch und Deutsch, weil die
 * Sprache des Blattes dem Projekt folgt.
 *
 * Sie stehen hier, weil eine reine Heuristik an genau den Zeilen scheitert, auf
 * die es ankommt: „Brand OffiTec Heating & Cooling" und „Unit Technical
 * Specifications" sehen gleich aus — beide sind grossgeschriebene Wortfolgen
 * ohne Zahl. Nur das WISSEN, dass „Brand" eine Bezeichnung ist und „Unit
 * Technical Specifications" keine, trennt die Angabe von der Überschrift.
 *
 * Was hier nicht steht, wird weiterhin geraten (Einheit, Zahlenblock) — die
 * Liste muss also nicht vollständig sein, sie muss nur die Zeilen kennen, die
 * sonst als Überschrift durchgingen.
 */
const KNOWN_LABELS = [
    // Kopf des Blattes
    'Project Name', 'Project Number', 'First Name', 'Last Name', 'Company Name',
    'Email', 'Phone Number', 'Country', 'Postal Code / City', 'Address', 'Date',
    'Projektname', 'Projektnummer', 'Vorname', 'Nachname', 'Firma',
    'E-Mail', 'Telefon', 'Land', 'PLZ / Ort', 'Adresse', 'Datum',
    // Die Einheit
    'Brand', 'Model', 'Category', 'Marke', 'Modell', 'Kategorie',
    'List price (non-binding) excluding', 'List price (non-binding) including',
    'Listenpreis',
    // Betriebspunkt und Ergebnis
    'Ambient Temperature', 'Water Inlet Temperature', 'Water Outlet Temperature',
    'Glycol Mixture', 'Glycol Ratio', 'Cooling Capacity', 'Heating Capacity',
    'Input Power', 'EER', 'COP', 'Current',
    'Umgebungstemperatur', 'Glykolmischung', 'Kühlleistung', 'Heizleistung',
    // Technik
    'Refrigerant', 'Compressor Quantity', 'Inverter', 'Circuit Quantity',
    'Refrigerant Charge', 'Evaporator Type', 'Condenser Type',
    'Evaporator Flow Rate', 'Water Pressure (System Need)', 'Evaporator Pressure Drop',
    'Fan Type', 'Number of Fans', 'Air Flow Rate',
    'Water Inlet Connection', 'Water Outlet Connection',
    'Power Supply', 'MOC', 'LRA', 'Frequency',
    'Sound Pressure Level at 1 m', 'Sound Pressure Level at 10 m', 'Sound Power',
    'Length', 'Width', 'Height', 'Weight', 'Operating Weight',
    'Kältemittel', 'Verdampfertyp', 'Verflüssigertyp', 'Länge', 'Breite',
    'Höhe', 'Gewicht', 'Betriebsgewicht',
]
    // Die längste Bezeichnung zuerst: „Sound Pressure Level at 10 m" darf nicht
    // an „Sound Pressure Level at 1 m" hängen bleiben.
    .sort((a, b) => b.length - a.length);
/** Ist die Zeile ein Satz und keine Angabe? */
const isProse = (line) => (line.length > 90
    || /[.!?]$/.test(line)
    || /:$/.test(line)
    || line.split(/\s+/).length > 14);
/**
 * Eine Zeile in Bezeichnung / Einheit / Wert zerlegen. Geschnitten wird an der
 * LETZTEN Einheit, die als eigenes Wort dasteht — „Evaporator Type **Type**
 * Plate Type" hat sein Trennwort in der Mitte, nicht am Anfang.
 *
 * Ohne Einheit bleibt die Zeile trotzdem eine Zeile: dann trennt der erste
 * Zahlenblock ("Power Supply 400/3/50"), und findet sich auch der nicht, ist
 * die ganze Zeile die Bezeichnung ohne Wert. Verloren geht dabei nichts —
 * die Rohzeile steht in `raw`.
 */
const splitRow = (line) => {
    const words = line.split(/\s+/);
    if (words.length < 2)
        return null;
    /* Eine bekannte Bezeichnung schlägt jede Heuristik. Der Rest der Zeile ist
       ihr Wert — und beginnt er mit einer Einheit, ist es ihre Einheit. */
    const known = KNOWN_LABELS.find((label) => (line.toLowerCase().startsWith(`${label.toLowerCase()} `)));
    if (known) {
        const rest = line.slice(known.length).trim();
        const restWords = rest.split(/\s+/);
        const leading = restWords[0];
        const hasUnit = Boolean(leading && UNIT_TOKENS.includes(leading) && restWords.length > 1);
        return {
            label: known,
            unit: hasUnit && leading !== '-' && leading !== 'Type' ? leading : null,
            value: hasUnit ? restWords.slice(1).join(' ') : rest,
            raw: line,
        };
    }
    for (let index = words.length - 2; index >= 1; index -= 1) {
        const word = words[index];
        if (!UNIT_TOKENS.includes(word))
            continue;
        const label = words.slice(0, index).join(' ').trim();
        const value = words.slice(index + 1).join(' ').trim();
        if (!label || !value)
            continue;
        return { label, unit: word === '-' || word === 'Type' ? null : word, value, raw: line };
    }
    // Keine Einheit: der Wert ist der letzte Block, der mit einer Ziffer
    // beginnt ("Water Inlet Connection 2 1/2", "Power Supply 400/3/50").
    const numberAt = words.findIndex((word, index) => index > 0 && /^[\d+]/.test(word));
    if (numberAt > 0) {
        return {
            label: words.slice(0, numberAt).join(' ').trim(),
            unit: null,
            value: words.slice(numberAt).join(' ').trim(),
            raw: line,
        };
    }
    return null;
};
/**
 * Ein Text wird zum Dokument. Eine Zeile ist entweder eine ÜBERSCHRIFT (kurz,
 * keine Angabe), eine ANGABE oder ein SATZ — und in dieser Reihenfolge wird
 * geprüft, weil nur die Angabe ein sicheres Kennzeichen hat.
 */
const parseDatasheetDocument = (text) => {
    const sections = [];
    const rows = [];
    let current = { title: '', rows: [], notes: [] };
    const push = () => {
        if (current.rows.length || current.notes.length || current.title)
            sections.push(current);
    };
    for (const rawLine of String(text || '').split(/\r?\n/)) {
        const line = rawLine.replace(/\s+/g, ' ').trim();
        if (!line || RUNNING_HEAD.test(line))
            continue;
        if (isProse(line)) {
            current.notes.push(line);
            continue;
        }
        const row = splitRow(line);
        if (row) {
            current.rows.push(row);
            rows.push(row);
            continue;
        }
        // Weder Satz noch Angabe: eine Überschrift. Sie beginnt einen neuen
        // Abschnitt — auch dann, wenn der vorige leer geblieben ist.
        push();
        current = { title: line, rows: [], notes: [] };
    }
    push();
    return { sections, rows };
};
exports.parseDatasheetDocument = parseDatasheetDocument;
const FIELDS = {
    model: { labels: ['Model', 'Modell'] },
    brand: { labels: ['Brand', 'Marke'] },
    category: { labels: ['Category', 'Kategorie'] },
    cooling: { labels: ['Cooling Capacity', 'Kühlleistung', 'Kälteleistung'], unit: 'kW' },
    heating: { labels: ['Heating Capacity', 'Heizleistung'], unit: 'kW' },
    eer: { labels: ['EER'] },
    cop: { labels: ['COP'] },
    refrigerant: { labels: ['Refrigerant', 'Kältemittel'] },
    evaporator: { labels: ['Evaporator Type', 'Verdampfertyp', 'Verdampfer Typ'] },
    condenser: { labels: ['Condenser Type', 'Verflüssigertyp', 'Verflüssiger Typ'] },
    glycol: { labels: ['Glycol Mixture', 'Glykolmischung', 'Glykol'] },
    sound1m: { labels: ['Sound Pressure Level at 1 m', 'Schalldruckpegel in 1 m', 'Schalldruck bei 1 m'] },
    sound10m: { labels: ['Sound Pressure Level at 10 m', 'Schalldruckpegel in 10 m', 'Schalldruck bei 10 m'] },
    length: { labels: ['Length', 'Länge'], unit: 'mm' },
    width: { labels: ['Width', 'Breite'], unit: 'mm' },
    height: { labels: ['Height', 'Höhe'], unit: 'mm' },
    weight: { labels: ['Operating Weight', 'Betriebsgewicht'], unit: 'kg' },
    listPrice: { labels: ['List price (non-binding) excluding', 'Listenpreis'] },
    dimensions: { labels: ['Abmessungen L x B x H', 'Abmessungen'] },
};
const normalise = (value) => value.toLowerCase().replace(/\s+/g, ' ').trim();
/** Die erste Zeile, deren Bezeichnung passt — und deren Einheit stimmt. */
const findRow = (rows, field) => {
    const wanted = field.labels.map(normalise);
    const matches = rows.filter((row) => wanted.includes(normalise(row.label)));
    if (!matches.length)
        return null;
    if (!field.unit)
        return matches[0];
    return (matches.find((row) => row.unit === field.unit) ?? null);
};
const valueOf = (rows, name) => {
    const field = FIELDS[name];
    if (!field)
        return undefined;
    const row = findRow(rows, field);
    const value = row?.value?.trim();
    return value ? value : undefined;
};
/**
 * Wert mit Einheit — aber nur EINMAL. Dieselbe Auswertung liest auch die
 * Markdown-Fassung zurück, und dort steht die Einheit bereits im Wert; ohne
 * diese Prüfung stünde nach einem Rundgang „63 dB(A) dB(A)" auf der Offerte.
 */
const withUnitOnce = (value, unit) => {
    if (!value)
        return undefined;
    return new RegExp(`${unit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i').test(value)
        ? value
        : `${value} ${unit}`;
};
/**
 * Die Produktangaben, wie sie auf die Offerte gehören — gelesen aus den
 * ZEILEN des Blattes, nie aus seinem Fliesstext.
 *
 * `medium` ist der einzige abgeleitete Wert: das Blatt nennt keine
 * Medienbezeichnung, sondern die Glykolmischung. „None" heisst Wasser.
 */
const specsFromDocument = (doc) => {
    const specs = {};
    const rows = doc.rows;
    const cooling = valueOf(rows, 'cooling');
    const heating = valueOf(rows, 'heating');
    if (heating) {
        specs.power = withUnitOnce(heating, 'kW');
        specs.powerIsCooling = false;
        if (cooling)
            specs.coolingPower = withUnitOnce(cooling, 'kW');
    }
    else if (cooling) {
        specs.power = withUnitOnce(cooling, 'kW');
        specs.powerIsCooling = true;
    }
    const cop = valueOf(rows, 'cop');
    const eer = valueOf(rows, 'eer');
    if (cop)
        specs.cop = cop;
    if (eer)
        specs.eer = eer;
    const glycol = valueOf(rows, 'glycol');
    if (glycol)
        specs.medium = /^(none|keine|kein|-)$/i.test(glycol) ? 'Wasser' : glycol;
    const technology = [
        valueOf(rows, 'evaporator') && `Verdampfer: ${valueOf(rows, 'evaporator')}`,
        valueOf(rows, 'condenser') && `Verflüssiger: ${valueOf(rows, 'condenser')}`,
        valueOf(rows, 'refrigerant') && `Kältemittel: ${valueOf(rows, 'refrigerant')}`,
    ].filter(Boolean);
    if (technology.length)
        specs.technology = technology.join('\n');
    const sound1m = valueOf(rows, 'sound1m');
    const sound10m = valueOf(rows, 'sound10m');
    if (sound1m)
        specs.sound1m = withUnitOnce(sound1m, 'dB(A)');
    if (sound10m)
        specs.sound10m = withUnitOnce(sound10m, 'dB(A)');
    // Nur vollständig: eine Länge ohne Breite und Höhe ist keine Abmessung.
    const length = valueOf(rows, 'length');
    const width = valueOf(rows, 'width');
    const height = valueOf(rows, 'height');
    if (length && width && height) {
        specs.dimensions = withUnitOnce(`${length} x ${width} x ${height}`, 'mm');
    }
    else {
        // Aus der Markdown-Fassung kommt die Abmessung als EIN Wert zurück.
        const whole = valueOf(rows, 'dimensions');
        if (whole)
            specs.dimensions = whole;
    }
    const weight = valueOf(rows, 'weight');
    if (weight)
        specs.weight = withUnitOnce(weight, 'kg');
    const model = valueOf(rows, 'model');
    const brand = valueOf(rows, 'brand');
    const category = valueOf(rows, 'category');
    if (model)
        specs.model = model;
    if (brand)
        specs.brand = brand;
    if (category)
        specs.category = category;
    /* Der Listenpreis steht auf dem Blatt und ist eine PRODUKTANGABE — er wird
       angezeigt, aber NIE in die Offerte übernommen: dort wird der Preis
       gerechnet und eingetragen (Vorgabe 27.08.2026, "nur die Gebühren"). */
    const listPrice = valueOf(rows, 'listPrice');
    if (listPrice) {
        /* Das Blatt schreibt „List price (non-binding) excluding 8.1% VAT CHF
           87'750.00" — die Bezeichnung trägt ihren Nachsatz mitten im Wert.
           Gemeint ist der BETRAG; steht keiner da, bleibt die Zeile, wie sie
           ist. */
        const amount = /((?:CHF|EUR|USD)\s*[\d'’., ]+)/i.exec(listPrice);
        specs.listPrice = (amount?.[1] || listPrice).trim();
    }
    return specs;
};
exports.specsFromDocument = specsFromDocument;
/* ── 3) Dokument → Markdown ─────────────────────────────────────────────── */
const mdEscape = (value) => value.replace(/\|/g, '\\|');
/** Die Produktangaben als Tabelle — die Kurzfassung ganz oben. */
const summaryTable = (specs) => {
    const rows = [
        ['Modell', specs.model],
        ['Marke', specs.brand],
        ['Kategorie', specs.category],
        [specs.powerIsCooling ? 'Kühlleistung' : 'Heizleistung', specs.power],
        ['Kühlleistung', specs.powerIsCooling ? undefined : specs.coolingPower],
        ['COP', specs.cop],
        ['EER', specs.eer],
        ['Medium', specs.medium],
        ['Schalldruck bei 1 m', specs.sound1m],
        ['Schalldruck bei 10 m', specs.sound10m],
        ['Abmessungen L x B x H', specs.dimensions],
        ['Betriebsgewicht', specs.weight],
        ['Listenpreis (unverbindlich)', specs.listPrice],
    ];
    const present = rows.filter(([, value]) => Boolean(value));
    if (!present.length)
        return [];
    const out = ['## Produktangaben', '', '| Angabe | Wert |', '| --- | --- |'];
    for (const [label, value] of present)
        out.push(`| ${mdEscape(label)} | ${mdEscape(value)} |`);
    if (specs.technology) {
        for (const line of specs.technology.split('\n')) {
            const [label, ...rest] = line.split(':');
            out.push(`| ${mdEscape((label || '').trim())} | ${mdEscape(rest.join(':').trim())} |`);
        }
    }
    out.push('');
    return out;
};
/**
 * Das ganze Blatt als Markdown. Oben die erkannten Produktangaben, darunter
 * das Blatt Abschnitt für Abschnitt — damit sichtbar bleibt, WORAUS die
 * Angaben oben gelesen wurden, und nichts verloren geht, was die OSP druckt.
 */
const buildDatasheetMarkdown = (doc, specs, meta = {}) => {
    const title = meta.title || specs.model || 'OSP-Datenblatt';
    const origin = [
        meta.projectNumber ? `Projekt ${meta.projectNumber}` : null,
        meta.documentId ? `Beleg ${meta.documentId}` : null,
        `geholt am ${new Date().toLocaleDateString('de-CH')}`,
    ].filter(Boolean).join(' · ');
    const lines = [`# ${title}`, '', `_${origin}_`, '', ...summaryTable(specs)];
    for (const section of doc.sections) {
        if (!section.rows.length && !section.notes.length)
            continue;
        if (section.title)
            lines.push(`## ${section.title}`, '');
        for (const row of section.rows) {
            lines.push(`- **${row.label}**${row.unit ? ` (${row.unit})` : ''}: ${row.value}`);
        }
        if (section.rows.length)
            lines.push('');
        for (const note of section.notes)
            lines.push(note, '');
    }
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
};
exports.buildDatasheetMarkdown = buildDatasheetMarkdown;
/* ── 4) Markdown → Produktangaben (der Rückweg) ──────────────────────────── */
/**
 * Kommt das Datenblatt bereits ALS Markdown (eine `.md`-Adresse im Webhook,
 * oder eine von Hand gepflegte Fassung), wird daraus dasselbe Dokument gelesen
 * wie aus dem PDF: Überschriften sind `#`-Zeilen, Angaben stehen als
 * Aufzählung `- **Bezeichnung** (Einheit): Wert` oder als Tabellenzeile
 * `| Bezeichnung | Wert |`.
 *
 * So ist es dieselbe Auswertung, egal woher die Fassung stammt.
 */
const parseMarkdownDocument = (markdown) => {
    const sections = [];
    const rows = [];
    let current = { title: '', rows: [], notes: [] };
    const push = () => {
        if (current.rows.length || current.notes.length || current.title)
            sections.push(current);
    };
    for (const rawLine of String(markdown || '').split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line)
            continue;
        const heading = /^#{1,6}\s+(.*)$/.exec(line);
        if (heading) {
            push();
            current = { title: (heading[1] || '').trim(), rows: [], notes: [] };
            continue;
        }
        // - **Cooling Capacity** (kW): 82.32
        const bullet = /^[-*]\s+\*{0,2}(.+?)\*{0,2}\s*(?:\(([^)]*)\))?\s*:\s*(.+)$/.exec(line);
        if (bullet) {
            const row = {
                label: (bullet[1] || '').replace(/\*/g, '').trim(),
                unit: (bullet[2] || '').trim() || null,
                value: (bullet[3] || '').trim(),
                raw: line,
            };
            current.rows.push(row);
            rows.push(row);
            continue;
        }
        // | Kühlleistung | 82.32 kW |
        if (line.startsWith('|')) {
            const cells = line.split('|').slice(1, -1).map((cell) => cell.replace(/\\\|/g, '|').trim());
            if (cells.length >= 2 && !/^-{2,}$/.test(cells[0] || '')) {
                const label = cells[0] || '';
                const value = (cells.length >= 3 ? cells[2] : cells[1]) || '';
                const unit = cells.length >= 3 ? (cells[1] || null) : null;
                if (label && value) {
                    const row = { label, unit: unit || null, value, raw: line };
                    current.rows.push(row);
                    rows.push(row);
                }
            }
            continue;
        }
        current.notes.push(line);
    }
    push();
    return { sections, rows };
};
exports.parseMarkdownDocument = parseMarkdownDocument;
//# sourceMappingURL=ospDatasheetDocument.js.map