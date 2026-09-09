/**
 * Prüft shared/totp.ts gegen die Prüfwerte der Norm — nicht gegen sich selbst.
 *
 *  • RFC 4226 Anhang D: HOTP mit dem Geheimnis "12345678901234567890"
 *    (ASCII) und den Zählern 0…9. Sechs Stellen, also genau das, was hier
 *    gerechnet wird.
 *  • RFC 6238: dasselbe Geheimnis, feste Zeitpunkte → feste Fenster.
 *  • Base32 hin und zurück, Wiederholungsschutz, Toleranzfenster.
 */
import {
    base32Encode,
    base32Decode,
    generateTotpSecret,
    currentTotpStep,
    totpCodeForStep,
    verifyTotpCode,
    buildOtpAuthUri,
    TOTP_PERIOD_SECONDS,
} from '../src/shared/totp';

let failed = 0;
const check = (name: string, actual: unknown, expected: unknown) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) failed += 1;
    console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}${ok ? '' : `\n        erwartet ${JSON.stringify(expected)}\n        erhalten ${JSON.stringify(actual)}`}`);
};

// ── Base32 ──────────────────────────────────────────────────────────────────
const ASCII_SECRET = '12345678901234567890';
const BASE32_SECRET = base32Encode(Buffer.from(ASCII_SECRET, 'ascii'));
check('base32Encode("12345678901234567890")', BASE32_SECRET, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
check('base32Decode ist die Umkehrung', base32Decode(BASE32_SECRET).toString('ascii'), ASCII_SECRET);
check('base32Decode nimmt Leerzeichen/Kleinschrift', base32Decode('gezd gnbv gy3t qojq gezd gnbv gy3t qojq').toString('ascii'), ASCII_SECRET);

// ── RFC 4226 Anhang D: HOTP, Zähler 0…9 ─────────────────────────────────────
const RFC4226 = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
RFC4226.forEach((expected, counter) => {
    check(`RFC 4226 Zähler ${counter}`, totpCodeForStep(BASE32_SECRET, counter), expected);
});

// ── RFC 6238: Zeitpunkt → Fenster ───────────────────────────────────────────
check('Fenster bei T=59s', currentTotpStep(59_000), 1);
check('Fenster bei T=1111111109s', currentTotpStep(1_111_111_109_000), 37037036);
check('Fenster bei T=2000000000s', currentTotpStep(2_000_000_000_000), 66666666);

// ── Prüfung: Fenster, Toleranz, Wiederholungsschutz ─────────────────────────
const now = Date.now();
const step = currentTotpStep(now);
const code = totpCodeForStep(BASE32_SECRET, step);

check('gültiger Code wird angenommen', verifyTotpCode(BASE32_SECRET, code, { atMs: now }), step);
check('mit Leerzeichen abgetippt', verifyTotpCode(BASE32_SECRET, `${code.slice(0, 3)} ${code.slice(3)}`, { atMs: now }), step);
check('falscher Code wird abgelehnt', verifyTotpCode(BASE32_SECRET, '000000', { atMs: now }) === step, false);
check('zu kurzer Code wird abgelehnt', verifyTotpCode(BASE32_SECRET, '12345', { atMs: now }), null);

// Toleranz: eine halbe Minute vor/zurück geht noch, eine ganze nicht mehr.
check('Code aus dem VORIGEN Fenster', verifyTotpCode(BASE32_SECRET, totpCodeForStep(BASE32_SECRET, step - 1), { atMs: now }), step - 1);
check('Code aus dem NÄCHSTEN Fenster', verifyTotpCode(BASE32_SECRET, totpCodeForStep(BASE32_SECRET, step + 1), { atMs: now }), step + 1);
check('Code von vor zwei Fenstern', verifyTotpCode(BASE32_SECRET, totpCodeForStep(BASE32_SECRET, step - 2), { atMs: now }), null);

// Wiederholungsschutz: derselbe Code ein zweites Mal.
check('verbrauchtes Fenster wird abgelehnt', verifyTotpCode(BASE32_SECRET, code, { atMs: now, notBeforeStep: step }), null);
check('das FOLGENDE Fenster geht wieder', verifyTotpCode(BASE32_SECRET, totpCodeForStep(BASE32_SECRET, step + 1), { atMs: now, notBeforeStep: step }), step + 1);

// ── Geheimnis + QR-Adresse ──────────────────────────────────────────────────
const fresh = generateTotpSecret();
check('frisches Geheimnis: 32 Base32-Zeichen (160 Bit)', /^[A-Z2-7]{32}$/.test(fresh), true);
check('zwei Geheimnisse sind verschieden', generateTotpSecret() === generateTotpSecret(), false);

const uri = buildOtpAuthUri({ secretBase32: BASE32_SECRET, account: 'anna@offitec.ch', issuer: 'Offitec Control Center' });
check(
    'otpauth-Adresse',
    uri,
    'otpauth://totp/Offitec%20ERP:anna%40offitec.ch?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Offitec+ERP&algorithm=SHA1&digits=6&period=30',
);
check('Fensterlänge ist 30 s', TOTP_PERIOD_SECONDS, 30);

console.log(failed === 0 ? '\nAlle Prüfungen bestanden.' : `\n${failed} Prüfung(en) fehlgeschlagen.`);
process.exit(failed === 0 ? 0 : 1);
