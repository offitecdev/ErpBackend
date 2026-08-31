"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchOspDatasheet = exports.mergeSpecs = exports.specsFromOfferEntry = exports.parseDatasheetSpecs = exports.pickDatasheetUrl = void 0;
const LocalFileStorage_1 = require("./LocalFileStorage");
/**
 * ── OSP-DATENBLATT (07.09.2026) ─────────────────────────────────────────────
 * Zu jeder angefragten Einheit gehört ein Datenblatt-PDF. Die OSP nennt seine
 * Adresse im Webhook; hier wird daraus eine Datei BEI UNS und daraus wiederum
 * die Beschreibung der Offertposition.
 *
 * Drei Grundsätze:
 *
 *  • Es ist das ECHTE PDF, nicht der Link auf die Offerte drüben. Was nicht
 *    mit `%PDF` beginnt, wird nicht angenommen — eine HTML-Seite, die nur
 *    aussieht wie ein Treffer (Anmeldemaske, Fehlerseite), fliegt raus, statt
 *    als „Datenblatt" an der Zeile zu landen.
 *
 *  • Der gemeinsame Schlüssel geht NUR an die OSP selbst. Zeigt die Adresse auf
 *    einen fremden Rechner (Ablage, CDN), wird ohne Schlüssel geholt — sonst
 *    verschenkte man ihn an den Erstbesten, der eine Adresse in den Webhook
 *    schreiben darf.
 *
 *  • Geholt wird EINMAL. Danach liegt die Datei bei uns: die Adresse drüben
 *    darf ablaufen, das Datenblatt der Offerte darf das nicht.
 */
/** Mehr als das ist kein Datenblatt mehr, sondern ein Versehen. */
const MAX_BYTES = 25 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20000;
/* ── 1) Welche Adresse im Webhook ist das PDF? ───────────────────────────── */
/** Schlüsselname ohne Trenner und Grossschreibung: `pdf_url` → `pdfurl`. */
const flatKey = (key) => key.toLowerCase().replace(/[\s_\-.]/g, '');
/**
 * Wie gut passt ein Feldname auf „das Datenblatt-PDF"? Grösser ist besser,
 * 0 heisst „kommt nicht in Frage".
 *
 * Die OSP liefert nachweislich mehr Felder, als der Vertrag beschreibt, und der
 * Name des neuen Feldes steht dort noch nicht fest. Statt auf EINEN Namen zu
 * wetten, wird der plausibelste genommen — und der Link auf die OFFERTE drüben
 * ausdrücklich abgelehnt, denn genau der ist hier nicht gemeint.
 */
const urlFieldScore = (key) => {
    const flat = flatKey(key);
    // Der Weg zur Offerte/zum Projekt in der OSP — nicht das Datenblatt.
    if (/(proposal|offerlink|offerurl|projecturl|projectlink|permalink|weblink)/.test(flat))
        return 0;
    let score = 0;
    if (flat.includes('datasheet') || flat.includes('datenblatt'))
        score += 100;
    if (flat.includes('pdf'))
        score += 80;
    if (flat.includes('report'))
        score += 40;
    if (flat.includes('document') || flat.includes('doc'))
        score += 30;
    if (flat.includes('attachment') || flat.includes('file'))
        score += 20;
    // "…url"/"…link"/"…href" allein macht noch kein Datenblatt, hebt aber einen
    // bereits passenden Namen über einen gleichnamigen Nicht-Adressfeldnamen.
    if (/(url|link|href|uri)$/.test(flat))
        score += 5;
    return score;
};
const asHttpUrl = (value) => {
    if (typeof value !== 'string')
        return null;
    const trimmed = value.trim();
    if (!/^https?:\/\//i.test(trimmed))
        return null;
    try {
        new URL(trimmed);
        return trimmed;
    }
    catch {
        return null;
    }
};
/**
 * Die Adresse des Datenblatts aus einem Webhook-Eintrag. Gesucht wird auch eine
 * Ebene tiefer (`document: { url }`, `datasheet: { href }`) — verschachtelt ist
 * genauso wahrscheinlich wie flach.
 */
const pickDatasheetUrl = (entry) => {
    if (!entry || typeof entry !== 'object')
        return null;
    // Seit der dritten Vertragsfassung steht der Name fest: `pdfUrl`, und
    // "nur Dokumente mit gerendertem PDF kommen überhaupt in einer Anfrage
    // vor" (§1) — also niemals null. Die Suche unten bleibt trotzdem stehen:
    // sie beantwortet die Frage für ältere Zeilen und für die Zusatzfelder,
    // die die OSP über den Vertrag hinaus mitschickt.
    const declared = asHttpUrl(entry.pdfUrl);
    if (declared)
        return declared;
    let best = null;
    const consider = (key, value, bonus) => {
        const url = asHttpUrl(value);
        if (!url)
            return;
        const score = urlFieldScore(key);
        if (!score)
            return;
        // Eine Adresse, die sichtbar auf ein PDF zeigt, sticht den Feldnamen.
        const total = score + bonus + (/\.pdf(\?|#|$)/i.test(url) ? 50 : 0);
        if (!best || total > best.score)
            best = { url, score: total };
    };
    for (const [key, value] of Object.entries(entry)) {
        consider(key, value, 0);
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            for (const [childKey, childValue] of Object.entries(value)) {
                // Der äussere Name trägt die Bedeutung ("datasheet"), der innere
                // ist meist nur "url" — deshalb zählt der äussere mit.
                consider(`${key}${childKey}`, childValue, 0);
            }
        }
    }
    return best ? best.url : null;
};
exports.pickDatasheetUrl = pickDatasheetUrl;
/* ── 2) Das PDF holen ────────────────────────────────────────────────────── */
const sameHost = (a, b) => {
    try {
        return new URL(a).host.toLowerCase() === new URL(b).host.toLowerCase();
    }
    catch {
        return false;
    }
};
const describeFailure = (error, url) => {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        return `Datenblatt antwortet nicht (${FETCH_TIMEOUT_MS} ms überschritten): ${url}`;
    }
    const code = error?.cause?.code || error?.code;
    if (code === 'ENOTFOUND')
        return `Adresse des Datenblatts unbekannt (DNS): ${url}`;
    if (code === 'ECONNREFUSED')
        return `Verbindung zum Datenblatt abgewiesen: ${url}`;
    return `${error?.message || 'Datenblatt nicht erreichbar.'}: ${url}`;
};
/* ── 3) Die Angaben aus dem Text lesen ───────────────────────────────────── */
/** Zahl mit Dezimalkomma/-punkt und Schweizer Tausender-Hochkomma. */
const NUM = String.raw `\d[\d'’.,\s]*`;
/**
 * Eine beschriftete Angabe suchen. Das Datenblatt kann die Beschriftung als
 * "Heizleistung: 227.3 kW" ODER — aus einer Tabellenspalte gelesen — auf der
 * nächsten Zeile führen; beides wird angenommen.
 */
const labelled = (text, labels, valuePattern) => {
    for (const label of labels) {
        const pattern = new RegExp(String.raw `${label}\s*[:\-–]?\s*(?:\r?\n\s*)?(${valuePattern})`, 'i');
        const hit = pattern.exec(text);
        const value = hit?.[1];
        if (value)
            return value.replace(/\s+/g, ' ').trim();
    }
    return undefined;
};
/**
 * Die Zeilen des Technologie-Blocks: Wärmetauscher, Kältemittel, Steuerung.
 * Gesucht wird zeilenweise nach Stichworten — ein Datenblatt schreibt sie
 * selten unter genau EINE Überschrift, und die Reihenfolge ist nicht sicher.
 */
const technologyLines = (text) => {
    const wanted = [
        /(verdampfer|verflüssiger|kondensator|wärmetauscher|w[äa]rme[üu]bertrager|PWT)/i,
        /(kältemittel|kaeltemittel|\bR\s?-?\s?(290|32|134a|410a|454|1234)\b)/i,
        /(steuerung|regelung|regler|schneider|siemens|carel)/i,
    ];
    const seen = new Set();
    const found = [];
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim().replace(/\s{2,}/g, ' ');
        // Zu kurz ist eine Tabellenzelle, zu lang ein Fliesstext-Absatz.
        if (line.length < 8 || line.length > 120)
            continue;
        if (!wanted.some((pattern) => pattern.test(line)))
            continue;
        const key = line.toLowerCase();
        if (seen.has(key))
            continue;
        seen.add(key);
        found.push(line);
        if (found.length >= 4)
            break;
    }
    return found.length ? found.join('\n') : undefined;
};
/**
 * Aus dem Datenblatt-Text die Angaben der Einheit. Was nicht dasteht, bleibt
 * leer — erfunden wird nichts; die fehlende Zeile tippt die Verkaufsseite.
 */
const parseDatasheetSpecs = (text) => {
    const specs = {};
    const cooling = labelled(text, ['Kühlleistung', 'Kuehlleistung', 'Kälteleistung', 'Cooling capacity'], `${NUM}\\s*kW`);
    const heating = labelled(text, ['Heizleistung', 'Heating capacity'], `${NUM}\\s*kW`);
    // Ein Chiller-Datenblatt führt beide Werte; dann gilt die Kühlleistung.
    if (cooling) {
        specs.power = cooling;
        specs.powerIsCooling = true;
    }
    else if (heating) {
        specs.power = heating;
        specs.powerIsCooling = false;
    }
    const cop = labelled(text, ['COP', 'EER', 'SCOP', 'Leistungszahl'], String.raw `\d+[.,]\d+`);
    if (cop)
        specs.cop = cop;
    const medium = labelled(text, ['Medium', 'Wärmeträger', 'Waermetraeger', 'Wärmeträgermedium'], String.raw `[A-Za-zÄÖÜäöüß/\- ]{3,40}`);
    if (medium)
        specs.medium = medium;
    const technology = technologyLines(text);
    if (technology)
        specs.technology = technology;
    const sound1m = labelled(text, [String.raw `Schalldruck(?:pegel)?\s*(?:bei|in|@)?\s*1\s*m`, String.raw `Sound pressure\s*(?:at|@)?\s*1\s*m`], String.raw `${NUM}\s*dB\s*\(?A?\)?[^\n]{0,60}`);
    if (sound1m)
        specs.sound1m = sound1m;
    const sound10m = labelled(text, [String.raw `Schalldruck(?:pegel)?\s*(?:bei|in|@)?\s*10\s*m`, String.raw `Sound pressure\s*(?:at|@)?\s*10\s*m`], String.raw `${NUM}\s*dB\s*\(?A?\)?[^\n]{0,60}`);
    if (sound10m)
        specs.sound10m = sound10m;
    const dimensions = labelled(text, [String.raw `Abmessungen(?:\s*\(?\s*L\s*[x×]\s*B\s*[x×]\s*H\s*\)?)?`, 'Dimensions', 'Masse'], String.raw `(?:ca\.\s*)?${NUM}\s*(?:mm|m)?\s*[x×]\s*${NUM}\s*(?:mm|m)?\s*[x×]\s*${NUM}\s*(?:mm|m)`);
    if (dimensions)
        specs.dimensions = dimensions;
    const weight = labelled(text, ['Betriebsgewicht', 'Gewicht', 'Operating weight', 'Leergewicht'], String.raw `(?:ca\.\s*)?${NUM}\s*kg`);
    if (weight)
        specs.weight = weight;
    return specs;
};
exports.parseDatasheetSpecs = parseDatasheetSpecs;
/* ── 3b) … oder direkt aus dem Webhook ───────────────────────────────────── */
/** "106.2" + " kW" — leere Angaben bleiben leer, `null` heisst "gibt es nicht". */
const withUnit = (value, unit) => {
    if (typeof value !== 'string' && typeof value !== 'number')
        return undefined;
    const text = String(value).trim();
    return text ? `${text} ${unit}` : undefined;
};
const plain = (value) => {
    if (typeof value !== 'string' && typeof value !== 'number')
        return undefined;
    const text = String(value).trim();
    return text ? text : undefined;
};
/**
 * Die berechneten Angaben der Einheit, wie §1 sie SELBST mitschickt.
 *
 * Bis zur dritten Vertragsfassung mussten sie aus dem PDF gelesen werden;
 * seither stehen sie im Webhook — abgelesen aus derselben Momentaufnahme, aus
 * der das PDF gerendert wurde, am eingegebenen Betriebspunkt statt am
 * Katalogwert. Sie sind damit die bessere Quelle, und das Auslesen des PDF
 * bleibt nur noch für das, was der Vertrag nicht kennt (das Medium) und für
 * ältere Belege, deren Bericht die Momentaufnahme noch nicht hatte: dort ist
 * jedes dieser Felder `null` (§1).
 *
 * `null` heisst ausdrücklich "gibt es an dieser Einheit nicht" — nie `0` oder
 * `""`. Es wird deshalb weggelassen, nicht als Leerwert übernommen.
 */
const specsFromOfferEntry = (entry) => {
    if (!entry || typeof entry !== 'object')
        return {};
    const row = entry;
    const specs = {};
    const cooling = withUnit(row.coolingCapacityKw, 'kW');
    const heating = withUnit(row.heatingCapacityKw, 'kW');
    // Eine Heizleistung gibt es nur an einer Wärmepumpe (§1) — dann ist SIE
    // die Kopfzahl, und die Kühlleistung steht daneben. Ein Chiller nennt
    // ausschliesslich die Kühlleistung.
    if (heating) {
        specs.power = heating;
        specs.powerIsCooling = false;
        if (cooling)
            specs.coolingPower = cooling;
    }
    else if (cooling) {
        specs.power = cooling;
        specs.powerIsCooling = true;
    }
    const cop = plain(row.cop);
    const eer = plain(row.eer);
    if (cop)
        specs.cop = cop;
    if (eer)
        specs.eer = eer;
    // Der Technologieblock der Offerte ist mehrzeilig; aus dem Vertrag kommen
    // drei seiner Zeilen benannt statt aus dem Fliesstext geraten.
    const technology = [
        plain(row.evaporatorType) && `Verdampfer: ${plain(row.evaporatorType)}`,
        plain(row.condenserType) && `Verflüssiger: ${plain(row.condenserType)}`,
        plain(row.refrigerant) && `Kältemittel: ${plain(row.refrigerant)}`,
    ].filter(Boolean);
    if (technology.length)
        specs.technology = technology.join('\n');
    const sound1m = withUnit(row.soundPressureAt1mDb, 'dB(A)');
    const sound10m = withUnit(row.soundPressureAt10mDb, 'dB(A)');
    if (sound1m)
        specs.sound1m = sound1m;
    if (sound10m)
        specs.sound10m = sound10m;
    // Nur vollständig: eine Länge ohne Breite und Höhe ist keine Abmessung.
    const length = plain(row.lengthMm);
    const width = plain(row.widthMm);
    const height = plain(row.heightMm);
    if (length && width && height)
        specs.dimensions = `${length} x ${width} x ${height} mm`;
    const weight = withUnit(row.operatingWeightKg, 'kg');
    if (weight)
        specs.weight = weight;
    return specs;
};
exports.specsFromOfferEntry = specsFromOfferEntry;
/**
 * Zwei Angabensätze übereinanderlegen. `stronger` gewinnt Feld für Feld, aber
 * nur mit einem ECHTEN Wert — so füllt das PDF weiterhin auf, was der Webhook
 * nicht kennt (das Medium), ohne je zu überschreiben, was er nennt.
 */
const mergeSpecs = (weaker, stronger) => {
    const merged = { ...(weaker || {}) };
    for (const [key, value] of Object.entries(stronger || {})) {
        if (value === undefined || value === null || value === '')
            continue;
        merged[key] = value;
    }
    return merged;
};
exports.mergeSpecs = mergeSpecs;
/* ── 4) Der ganze Weg: holen → ablegen → auslesen ────────────────────────── */
/**
 * Das Datenblatt einer Zeile holen, ablegen und auslesen. Wirft nie — wie jede
 * OSP-Strecke ist auch diese BEST-EFFORT: ein fehlendes Datenblatt darf weder
 * den Webhook noch den Import scheitern lassen.
 */
const fetchOspDatasheet = async (endpoint, tenantId, url) => {
    const base = (endpoint.ospBaseUrl || '').trim();
    const key = (endpoint.ospApiKey || '').trim();
    // Der Schlüssel gehört der OSP — er geht an keinen anderen Rechner.
    const headers = (key && base && sameHost(url, base))
        ? { 'X-OSP-Integration-Key': key }
        : {};
    let body;
    try {
        const response = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!response.ok) {
            const message = await response.text().catch(() => '');
            return { ok: false, error: `Datenblatt ${response.status}: ${message.slice(0, 200)}` };
        }
        body = Buffer.from(await response.arrayBuffer());
    }
    catch (error) {
        return { ok: false, error: describeFailure(error, url) };
    }
    if (!body.length)
        return { ok: false, error: 'Datenblatt ist leer.' };
    if (body.length > MAX_BYTES) {
        return { ok: false, error: `Datenblatt ist zu gross (${Math.round(body.length / 1024 / 1024)} MB).` };
    }
    // DAS PDF, nicht die Seite drumherum: eine Anmeldemaske oder Fehlerseite
    // kommt mit 200 zurück und sähe sonst wie ein Treffer aus.
    if (body.subarray(0, 5).toString('latin1') !== '%PDF-') {
        return { ok: false, error: 'Die Adresse liefert kein PDF (Link statt Datenblatt?).' };
    }
    let file;
    try {
        file = await LocalFileStorage_1.ospDatasheetStorage.store(tenantId, body, 'application/pdf');
    }
    catch (error) {
        return { ok: false, error: `Datenblatt konnte nicht abgelegt werden: ${error?.message || error}` };
    }
    // Ab hier ist die Datei sicher da. Misslingt das Auslesen, ist das ein
    // Schönheitsfehler — das Datenblatt selbst bleibt an der Zeile.
    try {
        const { extractText, getDocumentProxy } = await import('unpdf');
        const pdf = await getDocumentProxy(new Uint8Array(body));
        const extracted = await extractText(pdf, { mergePages: true });
        const text = String(extracted.text || '');
        return { ok: true, file, text, specs: (0, exports.parseDatasheetSpecs)(text) };
    }
    catch (error) {
        return { ok: true, file, error: `Datenblatt gespeichert, aber nicht lesbar: ${error?.message || error}` };
    }
};
exports.fetchOspDatasheet = fetchOspDatasheet;
//# sourceMappingURL=ospDatasheet.js.map