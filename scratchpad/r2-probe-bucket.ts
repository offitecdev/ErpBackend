import 'dotenv/config';
import { S3Client, HeadBucketCommand } from '@aws-sdk/client-s3';

/**
 * DEN NAMEN DES EIMERS FINDEN.
 *
 * Das Token darf die Eimer nicht auflisten, aber es darf "gibt es diesen?"
 * fragen. HeadBucket legt nichts an und aendert nichts — es antwortet nur.
 * Ein Treffer beendet die Suche.
 */
const CANDIDATES = [
    'offitec', 'offitec-erp', 'offitec-files', 'offitec-storage', 'offitec-uploads',
    'offitec-cdn', 'offitec-data', 'offitec-r2', 'offitecerp', 'offitec-documents',
    'erp', 'erp-files', 'erp-storage', 'erp-uploads', 'erp-documents',
    'files', 'storage', 'uploads', 'documents', 'media', 'images',
    'cdn', 'offitec-media', 'offitec-images', 'offitec-bucket', 'my-bucket',
];

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

    const extra = process.argv.slice(2);
    const names = [...extra, ...CANDIDATES];

    console.log(`${names.length} Namen werden gefragt...\n`);
    const denied: string[] = [];

    for (const name of names) {
        try {
            await client.send(new HeadBucketCommand({ Bucket: name }));
            console.log(`\nTREFFER: "${name}"\n`);
            console.log('Setzen mit:');
            console.log(`  node scratchpad/_set-env.js OFFITEC_S3_BUCKET ${name}`);
            process.exit(0);
        } catch (error: any) {
            const status = error?.$metadata?.httpStatusCode;
            // 404 = gibt es nicht. 403 = gibt es vielleicht, aber nicht fuer dieses Token.
            if (status === 403) denied.push(name);
        }
    }

    console.log('Kein Treffer.');
    if (denied.length > 0) {
        console.log(`(${denied.length} Namen antworteten mit 403 — die koennte es geben: ${denied.join(', ')})`);
    }
    console.log('\nDer Name steht in Cloudflare unter R2 in der Eimerliste.');
    console.log('Weitere Namen mitgeben:  ... r2-probe-bucket.ts meinname andername');
    process.exit(1);
})().catch((error) => { console.error(error); process.exit(1); });
