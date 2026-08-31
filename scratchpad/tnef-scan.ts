/* Was steckt in den winmail.dat-Anhängen? Beide Ordner, ganzes Fenster. */
import dotenv from 'dotenv';
dotenv.config({ path: `${__dirname}/../.env` });
import prisma from '../src/infrastructure/database/prisma.client';
import { buildImapClient } from '../src/infrastructure/services/ImapCaptureService';
import fs from 'fs';

const walk = (node: any, out: any[] = []): any[] => {
    if (!node) return out;
    out.push(node);
    for (const child of (node.childNodes || node.children || [])) walk(child, out);
    return out;
};

(async () => {
    const settings = await prisma.mailSetting.findFirst({
        where: { tenantId: 'offitec-root' },
        select: {
            tenantId: true, imapHost: true, imapPort: true, imapSecure: true, imapUser: true, imapPassword: true,
            smtpUser: true, smtpPassword: true, fromEmail: true, imapInboxFolder: true, sentFolder: true,
        },
    });
    const client = buildImapClient(settings as any);
    await client.connect();
    const since = new Date(); since.setMonth(since.getMonth() - 2);
    const folders = [settings!.imapInboxFolder?.trim() || 'INBOX', settings!.sentFolder?.trim() || 'INBOX.Sent'];
    let dumped = 0;
    for (const folder of folders) {
        let lock;
        try { lock = await client.getMailboxLock(folder, { readOnly: true }); }
        catch (e: any) { console.log('Ordner', folder, 'nicht lesbar:', e?.message); continue; }
        try {
            const uids = (await client.search({ since }, { uid: true })) as unknown as number[] || [];
            console.log(`\n=== ${folder}: ${uids.length} Nachrichten im Fenster ===`);
            let tnef = 0, ics = 0;
            for await (const msg of client.fetch(uids.map(String).join(','), { uid: true, envelope: true, bodyStructure: true }, { uid: true })) {
                const nodes = walk(msg.bodyStructure);
                const types = nodes.map((n) => String(n.type || '').toLowerCase());
                const names = nodes.map((n) => String(n.dispositionParameters?.filename || n.parameters?.name || '').toLowerCase());
                const hasIcs = types.some((t) => t === 'text/calendar') || names.some((n) => n.endsWith('.ics'));
                const tnefNode = nodes.find((n, i) => /ms-tnef/.test(types[i]!) || names[i] === 'winmail.dat');
                if (hasIcs) ics += 1;
                if (!tnefNode) continue;
                tnef += 1;
                console.log(`  UID ${msg.uid} | ${String(msg.envelope?.subject || '').slice(0, 60)}`);
                console.log(`      von ${msg.envelope?.from?.[0]?.address} → ${(msg.envelope?.to || []).map((p: any) => p.address).join(',')}`);
                console.log(`      Teil ${tnefNode.part} ${tnefNode.type} ${tnefNode.size}B | daneben ICS: ${hasIcs}`);
                if (dumped < 3) {
                    const dl = await client.download(String(msg.uid), String(tnefNode.part || '2'), { uid: true, maxBytes: 512 * 1024 });
                    const chunks: Buffer[] = [];
                    for await (const c of dl.content as any) chunks.push(c as Buffer);
                    const buf = Buffer.concat(chunks);
                    const file = `${__dirname}/tnef-sample-${folder.replace(/\W/g, '_')}-${msg.uid}.dat`;
                    fs.writeFileSync(file, buf);
                    console.log(`      → ${buf.length}B gespeichert: ${file}`);
                    dumped += 1;
                }
            }
            console.log(`  Summe ${folder}: ${tnef} mit winmail.dat, ${ics} mit text/calendar`);
        } finally { lock.release(); }
    }
    await client.logout();
    await prisma.$disconnect();
})();
