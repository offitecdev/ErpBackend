/**
 * Wegwerfkonto für die Sichtprüfung der Anmeldeseite.
 *
 *   npx ts-node --transpile-only scratchpad/_totp-testuser.ts create
 *   npx ts-node --transpile-only scratchpad/_totp-testuser.ts code     (aktueller Code)
 *   npx ts-node --transpile-only scratchpad/_totp-testuser.ts drop
 */
import path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: path.join(__dirname, '..', '.env') });

import prisma from '../src/infrastructure/database/prisma.client';
import { decryptTotpSecret } from '../src/infrastructure/services/totpCrypto';
import { totpCodeForStep, currentTotpStep, secondsLeftInStep } from '../src/shared/totp';

const ID = 'zz-totp-visual';
const EMAIL = 'zz-totp-visual@offitec.ch';
const PASSWORD = 'Selftest!2026x';

const main = async () => {
    const action = process.argv[2] || 'create';

    if (action === 'create') {
        const bcrypt = require('bcrypt');
        const tenant: any[] = await prisma.$queryRawUnsafe('SELECT id FROM Tenant WHERE isActive = 1 LIMIT 1');
        await prisma.$executeRawUnsafe('DELETE FROM Employee WHERE id = ?', ID);
        await prisma.employee.create({
            data: {
                id: ID,
                tenantId: tenant[0].id,
                firstName: 'Sicht',
                lastName: 'Test',
                email: EMAIL,
                passwordHash: await bcrypt.hash(PASSWORD, 12),
                isActive: true,
            },
        });
        console.log(`angelegt: ${EMAIL} / ${PASSWORD}`);
    }

    if (action === 'code') {
        const rows: any[] = await prisma.$queryRawUnsafe('SELECT totpSecret, totpLastStep FROM Employee WHERE id = ?', ID);
        const secret = decryptTotpSecret(rows[0]?.totpSecret);
        if (!secret) {
            console.log('noch nicht eingerichtet');
        } else {
            const step = currentTotpStep();
            const free = Math.max(step, Number(rows[0]?.totpLastStep ?? 0) + 1);
            console.log(`jetzt:  ${totpCodeForStep(secret, step)}  (noch ${secondsLeftInStep()} s)`);
            console.log(`frei:   ${totpCodeForStep(secret, free)}  (Fenster ${free}, zuletzt ${rows[0]?.totpLastStep})`);
        }
    }

    if (action === 'reset') {
        await prisma.$executeRawUnsafe('UPDATE Employee SET totpSecret = NULL, totpEnabledAt = NULL, totpLastStep = NULL WHERE id = ?', ID);
        console.log('zweiter Faktor zurueckgesetzt');
    }

    if (action === 'secret') {
        const rows: any[] = await prisma.$queryRawUnsafe('SELECT totpSecret FROM Employee WHERE id = ?', ID);
        console.log(decryptTotpSecret(rows[0]?.totpSecret) || 'KEINS');
    }

    if (action === 'drop') {
        await prisma.$executeRawUnsafe('DELETE FROM RefreshSession WHERE employeeId = ?', ID);
        await prisma.$executeRawUnsafe('DELETE FROM AuditLog WHERE employeeId = ?', ID);
        await prisma.$executeRawUnsafe('DELETE FROM Employee WHERE id = ?', ID);
        const left: any[] = await prisma.$queryRawUnsafe('SELECT COUNT(*) AS n FROM Employee WHERE id = ?', ID);
        console.log(`entfernt (Rest: ${left[0]?.n})`);
    }

    await prisma.$disconnect();
};

void main().catch((error) => {
    console.error('FEHLER:', error.message);
    process.exit(1);
});
