/* Misst, ob UV_THREADPOOL_SIZE tatsaechlich greift, wenn es IM CODE gesetzt
   wird (so wie main.ts es tut) statt in der Umgebung.

   Aufruf:  node _threadpool-probe.js <groesse|inherit> <anzahl>

   Gemessen wird die Wanduhrzeit fuer N gleichzeitige bcrypt-Vergleiche. Bei
   vier Plaetzen laufen sie in Schueben; mit mehr Plaetzen in einem Zug. Wenn
   das Setzen im Code wirkungslos waere, blieben beide Zeiten gleich. */
const requested = process.argv[2] || 'inherit';
if (requested !== 'inherit') {
    // GENAU wie in main.ts: gesetzt, bevor irgendetwas den Pool benutzt.
    process.env.UV_THREADPOOL_SIZE = String(requested);
}

const bcrypt = require('bcrypt');
const N = Number.parseInt(process.argv[3] || '8', 10);
// bcrypt(Kostenfaktor 12) Hash eines Wegwerfwerts — derselbe wie im LoginUseCase.
const HASH = '$2b$12$pnTvvJV1RFRAnjBSDLGVEejwkDI5j2V36hQM/LjiV7wGT/Xg9yTf6';

(async () => {
    // Einen Vergleich vorweg: er legt den Pool an und waermt den Code.
    await bcrypt.compare('warmup', HASH);
    const started = Date.now();
    await Promise.all(Array.from({ length: N }, () => bcrypt.compare('irgendwas', HASH)));
    const elapsed = Date.now() - started;
    console.log(JSON.stringify({
        requested,
        effective: process.env.UV_THREADPOOL_SIZE || '(unset)',
        parallel: N,
        elapsedMs: elapsed,
    }));
})();
