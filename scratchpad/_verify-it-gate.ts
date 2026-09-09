/* IT-Schleuse: kein Kennwort im Quelltext, und der Ausweisschlüssel ist NICHT
   das Kennwort. Reine Funktionsprüfung, kein Schreibvorgang. */
import crypto from 'crypto';
import {
    isItGateConfigured, verifyItGatePassword, issueItGateTicket, isValidItGateTicket,
} from '../src/presentation/middlewares/ItGateMiddleware';

const ok = (b: boolean) => (b ? 'OK  ' : 'FEHL');
const PERSON = 'employee-test-1';
const OTHER = 'employee-test-2';

console.log(`eingerichtet: ${isItGateConfigured()} (OFFITEC_IT_GATE_PASSWORD ${process.env.OFFITEC_IT_GATE_PASSWORD ? 'gesetzt' : 'LEER'})`);
console.log(`${ok(verifyItGatePassword(process.env.OFFITEC_IT_GATE_PASSWORD))} richtiges Kennwort wird angenommen`);
console.log(`${ok(!verifyItGatePassword('falsch'))} falsches Kennwort wird abgelehnt`);
console.log(`${ok(!verifyItGatePassword(''))} leere Eingabe wird abgelehnt`);
console.log(`${ok(!verifyItGatePassword(undefined))} fehlende Eingabe wird abgelehnt`);

const t = issueItGateTicket(PERSON);
console.log(`${ok(isValidItGateTicket(PERSON, t.ticket))} eigener Ausweis gilt`);
console.log(`${ok(!isValidItGateTicket(OTHER, t.ticket))} fremder Ausweis gilt nicht`);
console.log(`${ok(!isValidItGateTicket(PERSON, `${Date.now() + 60000}.gefaelscht`))} erfundene Unterschrift gilt nicht`);

/* Der Kern: mit dem KENNWORT als Schlüssel liess sich früher ein gültiger
   Ausweis selbst ausrechnen, ohne die Schleuse je zu durchlaufen. */
const expiresAt = Date.now() + 60_000;
const forgedWithPassword = `${expiresAt}.` + crypto
    .createHmac('sha256', process.env.OFFITEC_IT_GATE_PASSWORD || '162627')
    .update(`${PERSON}.${expiresAt}`)
    .digest('base64url');
console.log(`${ok(!isValidItGateTicket(PERSON, forgedWithPassword))} mit dem KENNWORT gerechneter Ausweis gilt NICHT mehr`);

const forgedWithOldDefault = `${expiresAt}.` + crypto
    .createHmac('sha256', '162627')
    .update(`${PERSON}.${expiresAt}`)
    .digest('base64url');
console.log(`${ok(!isValidItGateTicket(PERSON, forgedWithOldDefault))} mit '162627' gerechneter Ausweis gilt NICHT mehr`);

/* Und ohne eingerichtetes Kennwort ist die Schleuse ZU, nicht offen. */
const saved = process.env.OFFITEC_IT_GATE_PASSWORD;
delete process.env.OFFITEC_IT_GATE_PASSWORD;
console.log(`${ok(!isItGateConfigured())} ohne Umgebungsvariable: nicht eingerichtet`);
console.log(`${ok(!verifyItGatePassword('162627'))} ohne Umgebungsvariable: '162627' oeffnet nichts mehr`);
process.env.OFFITEC_IT_GATE_PASSWORD = saved;
