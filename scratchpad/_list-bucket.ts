import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';

const client = new S3Client({
    endpoint: process.env.OFFITEC_S3_ENDPOINT!,
    region: process.env.OFFITEC_S3_REGION || 'auto',
    credentials: {
        accessKeyId: process.env.OFFITEC_S3_ACCESS_KEY_ID!,
        secretAccessKey: process.env.OFFITEC_S3_SECRET_ACCESS_KEY!,
    },
    forcePathStyle: true,
});

(async () => {
    const bucket = process.env.OFFITEC_S3_BUCKET!;
    let token: string | undefined;
    const stats = new Map<string, { n: number; bytes: number }>();
    let total = 0;
    do {
        const out = await client.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token, MaxKeys: 1000 }));
        for (const o of out.Contents || []) {
            const key = o.Key || '';
            const kind = key.split('/')[0] || '(root)';
            const ext = (key.split('.').pop() || '').toLowerCase();
            const bucketKey = `${kind}  .${ext}`;
            const s = stats.get(bucketKey) || { n: 0, bytes: 0 };
            s.n += 1; s.bytes += Number(o.Size || 0);
            stats.set(bucketKey, s);
            total += 1;
        }
        token = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (token);
    [...stats.entries()].sort((a, b) => b[1].bytes - a[1].bytes)
        .forEach(([k, v]) => console.log(`${k.padEnd(34)} ${String(v.n).padStart(5)}  ${(v.bytes / 1024 / 1024).toFixed(2)} MB`));
    console.log('TOTAL objects:', total);
    process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
