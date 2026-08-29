import { nanoid } from 'nanoid';
import prisma from '../src/infrastructure/database/prisma.client';

/* END-ZU-END des OEFFENTLICHEN Formulars gegen den laufenden Server:
   Formular sicherstellen -> beschreiben -> absenden -> Zeile pruefen ->
   Honigtopf pruefen -> abgeschaltetes Formular pruefen -> aufraeumen. */

const BASE = 'http://localhost:3000/api/v1';

const say = (label: string, value: unknown) => console.log(label, JSON.stringify(value));

(async () => {
    const tenant = await prisma.tenant.findFirst({ select: { id: true, tenantName: true } });
    if (!tenant) throw new Error('kein Mandant');
    const tenantId = tenant.id;

    let form = await prisma.enquiryForm.findUnique({ where: { tenantId } });
    if (!form) {
        form = await prisma.enquiryForm.create({
            data: { id: nanoid(12), tenantId, token: nanoid(24), active: true },
        });
    } else if (!form.active) {
        form = await prisma.enquiryForm.update({ where: { tenantId }, data: { active: true } });
    }
    console.log('Mandant:', tenant.tenantName, '| Token:', form.token);

    // 1. Beschreiben
    const describe = await fetch(`${BASE}/public/enquiry/${form.token}`);
    say('GET  describe ->', { status: describe.status, body: await describe.json() });

    // 2. Absenden
    const subject = 'E2E ' + nanoid(6);
    const post = await fetch(`${BASE}/public/enquiry/${form.token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            companyName: 'E2E Test AG',
            contactName: 'Rita Roth',
            email: 'rita@e2e.example',
            phone: '+41 61 111 22 33',
            subject,
            message: 'Wir haetten gern eine Offerte fuer zwei Anlagen.\nZeile zwei.',
        }),
    });
    say('POST submit   ->', { status: post.status, body: await post.json() });

    const created = await prisma.enquiry.findFirst({ where: { tenantId, subject } });
    say('Zeile         ->', created && {
        source: created.source, status: created.status, email: created.email,
        company: created.companyName, hasCustomer: Boolean(created.customerId),
        messageLines: (created.message || '').split('\n').length,
    });

    // 3. Fehlende Adresse -> 400
    const bad = await fetch(`${BASE}/public/enquiry/${form.token}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject: 'ohne Adresse', message: 'x', email: 'keine-adresse' }),
    });
    say('POST ungueltige Adresse ->', { status: bad.status, body: await bad.json() });

    // 4. Honigtopf -> 201, aber KEINE Zeile
    const trapSubject = 'TRAP ' + nanoid(6);
    const trap = await fetch(`${BASE}/public/enquiry/${form.token}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'bot@spam.example', subject: trapSubject, message: 'x', website: 'http://spam' }),
    });
    const trapRow = await prisma.enquiry.findFirst({ where: { tenantId, subject: trapSubject } });
    say('POST Honigtopf ->', { status: trap.status, zeileAngelegt: Boolean(trapRow) });

    // 5. Abgeschaltet -> 404 auf BEIDEN Wegen
    await prisma.enquiryForm.update({ where: { tenantId }, data: { active: false } });
    const offGet = await fetch(`${BASE}/public/enquiry/${form.token}`);
    const offPost = await fetch(`${BASE}/public/enquiry/${form.token}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'a@b.ch', subject: 's', message: 'm' }),
    });
    say('abgeschaltet  ->', { get: offGet.status, post: offPost.status });
    await prisma.enquiryForm.update({ where: { tenantId }, data: { active: true } });

    // 6. Aufraeumen
    if (created) await prisma.enquiry.delete({ where: { id: created.id } });
    if (trapRow) await prisma.enquiry.delete({ where: { id: trapRow.id } });
    console.log('aufgeraeumt.');
    await prisma.$disconnect();
})().catch(async (error) => {
    console.error('FEHLER:', error);
    await prisma.$disconnect();
    process.exit(1);
});
