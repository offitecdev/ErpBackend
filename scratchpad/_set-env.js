const fs = require('fs');

/**
 * Setzt einen Wert in der .env, ohne ihn auszugeben.
 *   node scratchpad/_set-env.js OFFITEC_S3_BUCKET meinname
 */
const [key, value] = process.argv.slice(2);
if (!key) { console.error('Schluessel fehlt.'); process.exit(1); }

const file = '.env';
const crlf = fs.readFileSync(file, 'utf8').includes('\r\n');
const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);

let found = false;
for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith(`${key}=`)) {
        lines[i] = `${key}=${value ?? ''}`;
        found = true;
        break;
    }
}
if (!found) lines.push(`${key}=${value ?? ''}`);

fs.writeFileSync(file, lines.join(crlf ? '\r\n' : '\n'));
console.log(`${key}: gesetzt (${(value || '').length} Zeichen)`);
