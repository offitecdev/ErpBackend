/* Ein winmail.dat aus dem Postfach holen und roh zerlegen. Aufruf: <Ordner> <UID> <Teil> */
import dotenv from 'dotenv';
dotenv.config({ path: `${__dirname}/../.env` });
import prisma from '../src/infrastructure/database/prisma.client';
import { buildImapClient } from '../src/infrastructure/services/ImapCaptureService';
import fs from 'fs';

(async () => {
    const [folder = 'INBOX.Sent', uid = '213', part = '2'] = process.argv.slice(2);
    const settings = await prisma.mailSetting.findFirst({
        where: { tenantId: 'offitec-root' },
        select: {
            tenantId: true, imapHost: true, imapPort: true, imapSecure: true, imapUser: true, imapPassword: true,
            smtpUser: true, smtpPassword: true, fromEmail: true, imapInboxFolder: true, sentFolder: true,
        },
    });
    const client = buildImapClient(settings as any);
    await client.connect();
    const lock = await client.getMailboxLock(folder, { readOnly: true });
    try {
        const dl = await client.download(uid, part, { uid: true, maxBytes: 1024 * 1024 });
        const chunks: Buffer[] = [];
        for await (const c of dl.content as any) chunks.push(c as Buffer);
        const buf = Buffer.concat(chunks);
        const file = `${__dirname}/tnef-sample-${uid}.dat`;
        fs.writeFileSync(file, buf);
        console.log(`${buf.length} Bytes → ${file}`);
        console.log('Signatur:', buf.readUInt32LE(0).toString(16), '(erwartet 223e9f78)');
        // Attribute durchgehen
        let off = 6;
        while (off + 9 <= buf.length) {
            const level = buf[off]!; const attr = buf.readUInt32LE(off + 1); const len = buf.readUInt32LE(off + 5);
            const id = attr & 0xffff, type = attr >>> 16;
            const data = buf.subarray(off + 9, off + 9 + len);
            const preview = type === 1 || type === 2 ? JSON.stringify(data.toString('latin1').replace(/\0+$/, '').slice(0, 80)) : data.subarray(0, 24).toString('hex');
            console.log(`lvl ${level} att 0x${id.toString(16).padStart(4, '0')} typ 0x${type.toString(16).padStart(4, '0')} len ${len}  ${preview}`);
            off += 9 + len + 2;
        }
    } finally { lock.release(); }
    await client.logout();
    await prisma.$disconnect();
})();
