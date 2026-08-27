import { appointmentDocumentStorage } from '../src/infrastructure/services/LocalFileStorage';
import { sanitizeDocumentUpload } from '../src/presentation/controllers/appointmentSeries';

/**
 * Der schnelle Weg einer Terminunterlage, ohne HTTP: rohe Datei rein, Verweis
 * raus, Inhalt wieder zurück — und am Schluss wieder weg.
 */
(async () => {
    const pdf = Buffer.from('%PDF-1.4\n% offitec test\n');

    // 1) Der rohe Weg (multipart) — so kommt die Datei aus dem Browser.
    const raw = sanitizeDocumentUpload({}, { originalname: 'plan.pdf', mimetype: 'application/pdf', buffer: pdf });
    console.log('raw upload:', raw.fileName, raw.contentType, raw.sizeBytes, 'bytes');

    // 2) Der zweite Weg (Daten-URI) muss dasselbe ergeben.
    const viaDataUri = sanitizeDocumentUpload({
        fileName: 'plan.pdf',
        contentType: 'application/pdf',
        data: `data:application/pdf;base64,${pdf.toString('base64')}`,
    });
    console.log('data-uri upload equals raw:', viaDataUri.body.equals(raw.body), '| size', viaDataUri.sizeBytes);

    // 3) Ablegen, lesen, entfernen.
    const reference = await appointmentDocumentStorage.store('test-tenant', raw.body, raw.contentType);
    console.log('reference:', reference);
    const back = await appointmentDocumentStorage.read(reference);
    console.log('read back identical:', back.equals(pdf));
    await appointmentDocumentStorage.remove(reference);
    console.log('removed:', await appointmentDocumentStorage.read(reference).then(() => false).catch(() => true));

    // 4) Was nicht durchgehen darf.
    for (const [label, run] of [
        ['wrong type', () => sanitizeDocumentUpload({}, { originalname: 'x.exe', mimetype: 'application/x-msdownload', buffer: pdf })],
        ['no name', () => sanitizeDocumentUpload({}, { originalname: '', mimetype: 'application/pdf', buffer: pdf })],
        ['empty', () => sanitizeDocumentUpload({}, { originalname: 'x.pdf', mimetype: 'application/pdf', buffer: Buffer.alloc(0) })],
    ] as Array<[string, () => unknown]>) {
        try { run(); console.log('NOT REJECTED (bad):', label); }
        catch (error: any) { console.log('rejected ok:', label, '|', error.message); }
    }
    process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
