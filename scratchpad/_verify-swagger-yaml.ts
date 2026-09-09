import swaggerJsdoc from 'swagger-jsdoc';
import fs from 'fs';
import path from 'path';

/* Ein einziger kaputter YAML-Block reisst die GANZE Dokumentation mit: swagger-jsdoc
   liest jede Datei einzeln und meldet den Fehler, lässt die Route aber aus dem
   Ergebnis fallen. Darum wird hier JEDE Routendatei für sich geprüft — so steht
   am Ende, welche Datei klemmt, und nicht bloss, DASS etwas klemmt. */
const dir = path.join(__dirname, '..', 'src', 'presentation', 'routes');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.ts')).sort();

let broken = 0;
let paths = 0;
for (const file of files) {
    const full = path.join(dir, file);
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: any[]) => errors.push(args.map(String).join(' '));
    let spec: any;
    try {
        spec = swaggerJsdoc({
            definition: { openapi: '3.0.0', info: { title: 'probe', version: '1' } },
            apis: [full],
        });
    } catch (e: any) {
        errors.push(e?.message || String(e));
    } finally {
        console.error = originalError;
    }
    const count = Object.keys(spec?.paths || {}).length;
    paths += count;
    if (errors.length) {
        broken += 1;
        console.log(`\n✗ ${file}`);
        for (const line of errors) console.log('   ', line.split('\n')[0]);
    }
}
console.log(`\n${files.length} Routendateien, ${paths} dokumentierte Pfade, ${broken} mit YAML-Fehler.`);
process.exit(broken ? 1 : 0);
