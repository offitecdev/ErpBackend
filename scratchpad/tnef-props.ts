/* Die Eigenschaften einer winmail.dat mit dem eigenen Parser lesen. Aufruf: <datei> */
import fs from 'fs';
import { parseTnef, calendarEventsFromTnef } from '../src/infrastructure/services/tnef';
const buf = fs.readFileSync(process.argv[2] || `${__dirname}/tnef-sample-213.dat`);
const msg = parseTnef(buf)!;
console.log('Klasse:', msg.messageClass, '| Codepage:', msg.codepage, '| Betreff:', msg.subject);
console.log('DTR start/end:', msg.dateStart?.toISOString(), msg.dateEnd?.toISOString());
console.log('Eigenschaften:', msg.props.size, '| Empfänger:', msg.recipients.length, '| Anhänge:', msg.attachments.length);
for (const p of msg.props.values()) {
    const v = p.values[0];
    const shown = Buffer.isBuffer(v) ? `<${v.length}B ${v.subarray(0, 24).toString('hex')}>` : v instanceof Date ? v.toISOString() : JSON.stringify(v)?.slice(0, 90);
    if (/^tag:(001a|0037|0042|0065|0060|0061|0c1a|0c1f|1000|5d01|5d02)$/.test(p.key) || !p.key.startsWith('tag:')) console.log('  ', p.key, 'typ', p.type.toString(16), shown);
}
for (const r of msg.recipients) console.log('  Empfänger:', [...r.values()].filter((p) => /^tag:(3001|3003|39fe|0c15)$/.test(p.key)).map((p) => `${p.key}=${JSON.stringify(p.values[0])}`).join(' '));
console.log('\nTermine:', JSON.stringify(calendarEventsFromTnef(buf), null, 1).slice(0, 1500));
