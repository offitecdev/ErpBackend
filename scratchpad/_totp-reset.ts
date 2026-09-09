/**
 * ── NOTAUSGANG: ZWEITEN FAKTOR EINER PERSON ZURÜCKSETZEN ────────────────────
 *
 * Der gewöhnliche Weg ist `PATCH /employees/:id/mfa-reset` — den geht die
 * Verwaltung aus der Anwendung heraus. Dieses Skript ist für den einen Fall,
 * in dem das nicht geht: es ist NIEMAND mehr drin, der zurücksetzen könnte
 * (das Telefon des Administrators ist weg, und ein zweiter Administrator
 * existiert nicht).
 *
 * Es setzt nur die drei Spalten des zweiten Faktors zurück; das Kennwort und
 * alles andere bleibt. Die Person wird bei der nächsten Anmeldung erneut durch
 * die Einrichtung geführt. Die offenen Sitzungen bleiben stehen — wer das
 * nicht will, meldet sich einmal ab.
 *
 *   npx ts-node --transpile-only scratchpad/_totp-reset.ts <e-mail>
 *   npx ts-node --transpile-only scratchpad/_totp-reset.ts --liste
 */
import path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: path.join(__dirname, '..', '.env') });

import prisma from '../src/infrastructure/database/prisma.client';

const main = async () => {
    const argument = (process.argv[2] || '').trim();

    if (!argument || argument === '--liste') {
        const rows: any[] = await prisma.$queryRawUnsafe(
            'SELECT email, firstName, lastName, totpEnabledAt FROM Employee WHERE totpEnabledAt IS NOT NULL ORDER BY totpEnabledAt',
        );
        if (!rows.length) console.log('Niemand hat den zweiten Faktor eingerichtet.');
        else {
            console.log('Eingerichtet:');
            for (const row of rows) {
                console.log(`  ${row.email}  (${row.firstName} ${row.lastName}, seit ${row.totpEnabledAt.toISOString()})`);
            }
        }
        console.log('\nZurücksetzen:  npx ts-node --transpile-only scratchpad/_totp-reset.ts <e-mail>');
        await prisma.$disconnect();
        return;
    }

    const found: any[] = await prisma.$queryRawUnsafe(
        'SELECT id, email, totpEnabledAt FROM Employee WHERE email = ?', argument,
    );
    if (!found.length) {
        console.log(`Kein Konto mit der Adresse ${argument}.`);
        await prisma.$disconnect();
        process.exit(1);
    }
    if (!found[0].totpEnabledAt) {
        console.log(`${argument} hat gar keinen zweiten Faktor eingerichtet — nichts zu tun.`);
        await prisma.$disconnect();
        return;
    }

    await prisma.$executeRawUnsafe(
        'UPDATE Employee SET totpSecret = NULL, totpEnabledAt = NULL, totpLastStep = NULL WHERE id = ?',
        found[0].id,
    );
    console.log(`${argument}: zweiter Faktor zurückgesetzt. Die nächste Anmeldung führt durch die Einrichtung.`);
    await prisma.$disconnect();
};

void main().catch((error) => {
    console.error('FEHLER:', error.message);
    process.exit(1);
});
