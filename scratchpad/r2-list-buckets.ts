import 'dotenv/config';
import { S3Client, ListBucketsCommand } from '@aws-sdk/client-s3';

/**
 * Welche Eimer gehoeren zu diesem Konto? Nur lesen — es wird nichts angelegt
 * und nichts veraendert. Ist das Token auf genau einen Eimer beschraenkt,
 * verweigert Cloudflare die Auskunft; dann muss der Name von Hand kommen.
 */
(async () => {
    const endpoint = process.env.OFFITEC_S3_ENDPOINT;
    if (!endpoint) { console.error('OFFITEC_S3_ENDPOINT fehlt.'); process.exit(1); }

    const client = new S3Client({
        endpoint,
        region: 'auto',
        credentials: {
            accessKeyId: process.env.OFFITEC_S3_ACCESS_KEY_ID!,
            secretAccessKey: process.env.OFFITEC_S3_SECRET_ACCESS_KEY!,
        },
        forcePathStyle: true,
    });

    try {
        const result = await client.send(new ListBucketsCommand({}));
        const buckets = result.Buckets ?? [];
        if (buckets.length === 0) {
            console.log('Das Konto hat noch keinen Eimer. In Cloudflare unter R2 einen anlegen.');
            process.exit(1);
        }
        console.log(`${buckets.length} Eimer gefunden:\n`);
        for (const bucket of buckets) {
            console.log(`  ${bucket.Name}   (angelegt ${bucket.CreationDate?.toISOString?.() ?? '?'})`);
        }
        if (buckets.length === 1) {
            console.log(`\nEindeutig. Setzen mit:\n  node scratchpad/_set-env.js OFFITEC_S3_BUCKET ${buckets[0].Name}`);
        }
        process.exit(0);
    } catch (error: any) {
        const text = `${error?.name} ${error?.Code} ${error?.message}`;
        if (/AccessDenied/i.test(text) || error?.$metadata?.httpStatusCode === 403) {
            console.log('Das Token darf die Eimer nicht auflisten (es ist auf einen beschraenkt).');
            console.log('Der Name muss von Hand in OFFITEC_S3_BUCKET.');
        } else {
            console.log(`Auskunft fehlgeschlagen: ${text}`);
        }
        process.exit(1);
    }
})().catch((error) => { console.error(error); process.exit(1); });
