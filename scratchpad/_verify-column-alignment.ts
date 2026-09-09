import 'dotenv/config';

/* ── PRÜFUNG DER SPALTENFLUCHT (Fehlerbild Samet 08.09.2026) ────────────────
   «Alles ist durcheinander — ob Excel oder PNG, die Werte müssen zu ihren
    Spalten passen. Leerstellen dürfen die Angaben nicht verschieben.»

   `compactText` staucht den Beleg, bevor er an das Modell geht. Genau dort ging
   die Spaltenflucht verloren: JEDER Lauf von Leerraum wurde EIN Leerzeichen,
   also auch der Tabulator einer Excel-Tabelle und der Kolonnenabstand einer
   PDF-Textlage. Eine leere Zelle verschwand damit spurlos und alles rechts
   davon rutschte eine Spalte nach links.

   Aufruf: npx ts-node scratchpad/_verify-column-alignment.ts */

import { compactText } from '../src/infrastructure/services/documentText';

let failed = 0;
const say = (label: string, ok: boolean, extra = '') => {
    if (!ok) failed += 1;
    console.log(`${ok ? '  OK ' : '  -- '} ${label}${extra ? ` — ${extra}` : ''}`);
};
/** Tabulatoren sichtbar machen, sonst sieht man im Log nichts. */
const show = (text: string) => text.replace(/\t/g, '⇥');
/** Die Zellen einer Zeile, so wie das Modell sie zählen soll. */
const cells = (value: string | undefined) => String(value ?? '').split('\t');
/** Eine Zelle nach Nummer — nie `undefined`, damit die Pruefung lesbar bleibt. */
const at = (value: string | undefined, index: number) => cells(value)[index] ?? '';
const ln = (all: string[], index: number) => all[index] ?? '';

console.log('\n── Excel: die Tabelle kommt schon mit Tabulatoren ──────');
{
    // Zeile 2 hat KEINEN Bruttopreis und KEINEN Rabatt — zwei leere Zellen.
    const sheet = [
        'Code\tBezeichnung\tMenge\tBrutto\tRabatt\tNetto',
        'LC1D09BD\tTeSys Deca contactor\t2\t78.10\t45.36\t42.67',
        'XB4-BA31\tDrucktaster\t1\t\t\t9.90',
        '\tOhne Code gedruckt\t5\t12.00\t\t12.00',
    ].join('\n');
    const out = compactText(sheet);
    const lines = out.split('\n');

    say('alle vier Zeilen bleiben', lines.length === 4, `${lines.length}`);
    say('Kopfzeile: 6 Spalten', cells(ln(lines, 0)).length === 6, show(ln(lines, 0)));
    say('volle Zeile: 6 Spalten', cells(ln(lines, 1)).length === 6, show(ln(lines, 1)));
    say('Zeile MIT zwei leeren Zellen behält 6 Spalten',
        cells(ln(lines, 2)).length === 6, show(ln(lines, 2)));
    say('  → Brutto ist leer', at(ln(lines, 2), 3) === '', `"${at(ln(lines, 2), 3)}"`);
    say('  → Rabatt ist leer', at(ln(lines, 2), 4) === '', `"${at(ln(lines, 2), 4)}"`);
    say('  → Netto bleibt in SEINER Spalte', at(ln(lines, 2), 5) === '9.90', at(ln(lines, 2), 5));
    say('führende leere Zelle bleibt erhalten',
        cells(ln(lines, 3)).length === 6 && at(ln(lines, 3), 0) === '', show(ln(lines, 3)));
    say('  → die Bezeichnung rutscht NICHT auf Spalte 1',
        at(ln(lines, 3), 1) === 'Ohne Code gedruckt', at(ln(lines, 3), 1));
}

console.log('\n── PDF-Textlage: Spalten stehen als Abstände ──────────');
{
    const pdf = [
        'Pos   Artikel      Bezeichnung            Menge   Brutto   Rabatt   Netto',
        '1     LC1D09BD     TeSys Deca contactor       2    78.10    45.36   42.67',
        '2     XB4-BA31     Drucktaster                1                      9.90',
    ].join('\n');
    const out = compactText(pdf);
    const lines = out.split('\n');

    say('Zeile 1 zerfällt in Spalten', cells(ln(lines, 1)).length >= 6, show(ln(lines, 1)));
    say('Menge und Preis stehen in GETRENNTEN Zellen',
        at(ln(lines, 1), 3) === '2' && at(ln(lines, 1), 4) === '78.10', show(ln(lines, 1)));
    say('die Lücke der zweiten Zeile ist eine Grenze',
        cells(ln(lines, 2)).length > 4, show(ln(lines, 2)));
    say('9.90 bildet eine eigene Zelle, klebt nicht an der Menge',
        at(ln(lines, 2), 4) === '9.90' && at(ln(lines, 2), 3) === '1', show(ln(lines, 2)));

    /* ── DIE GRENZE DIESES WEGES, AUSDRUECKLICH ─────────────────────────────
       In einer PDF-TEXTLAGE steht zwischen zwei Zellen nichts als Leerraum.
       Ob eine breite Luecke EINE leere Spalte meint oder DREI, sagt die Breite
       nicht verlaesslich — Spalten sind verschieden breit, und eine kurze
       Bezeichnung erzeugt dieselbe Luecke wie eine fehlende Angabe. Wir machen
       daraus EINE Grenze und erfinden keine zweite dazu; die Zuordnung leistet
       dann die Kopfzeile, auf die die Anweisung das Modell ausdruecklich
       verweist ("match them against the header line of the table").

       Bei EXCEL stellt sich die Frage nicht: dort kommen echte Tabulatoren mit,
       und die bleiben Zelle fuer Zelle stehen (siehe oben). Beim BILD auch
       nicht: dort sieht das Modell die Spalten selbst. */
    say('bekannte Grenze: zwei leere Spalten werden EINE Grenze (Textlage)',
        cells(ln(lines, 2)).length === 5,
        `${cells(ln(lines, 2)).length} Zellen gegen 7 in der Kopfzeile — die Kopfzeile ordnet zu`);
}

console.log('\n── Der Wortabstand bleibt ein Wortabstand ─────────────');
{
    const out = compactText('LC1D09BD\tTeSys Deca contactor - 3P(3 NO) - AC-3\t2');
    const parts = cells(out);
    say('drei Zellen', parts.length === 3, show(out));
    say('die Bezeichnung bleibt EIN Wert, ungeteilt',
        (parts[1] ?? '') === 'TeSys Deca contactor - 3P(3 NO) - AC-3', parts[1] ?? '');
}

console.log('\n── Gespart wird trotzdem ──────────────────────────────');
{
    const wide = 'A' + ' '.repeat(40) + 'B' + ' '.repeat(40) + 'C';
    const out = compactText(wide);
    say('vierzig Ausrichtungszeichen werden EIN Trenner',
        out === 'A\tB\tC', show(out));
    say('kürzer als das Original', out.length < wide.length, `${wide.length} → ${out.length}`);
}

console.log('\n── Was schon galt, gilt weiter ────────────────────────');
{
    const messy = [
        'Muster Handels AG', 'Bahnhofstrasse 1',
        'Pos   A-100  Schraube        100      0.90',
        'Seite 1 von 3',
        'Muster Handels AG', 'Bahnhofstrasse 1',
        'Pos   A-200  Mutter          100      0.40',
        'Seite 2 von 3',
        'Muster Handels AG', 'Bahnhofstrasse 1',
        'Pos   A-300  Scheibe         100      0.15',
        'Seite 3 von 3',
    ].join('\n');
    const out = compactText(messy);
    say('Briefkopf nur einmal', (out.match(/Muster Handels AG/g) || []).length === 1);
    say('«Seite n von m» weg', !/Seite \d/.test(out));
    say('alle drei Preise da', ['0.90', '0.40', '0.15'].every((p) => out.includes(p)));
    say('alle drei Artikel da', ['A-100', 'A-200', 'A-300'].every((c) => out.includes(c)));
}

console.log(`\n${failed === 0 ? 'Alles wie verlangt.' : `${failed} Prüfung(en) fehlgeschlagen.`}`);
process.exit(failed === 0 ? 0 : 1);
