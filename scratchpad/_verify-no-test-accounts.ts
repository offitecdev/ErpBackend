/** Ist von den Prüfläufen nichts liegengeblieben? (Nur lesend.) */
import path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: path.join(__dirname, '..', '.env') });

import prisma from '../src/infrastructure/database/prisma.client';

const main = async () => {
    const leftovers: any[] = await prisma.$queryRawUnsafe(
        "SELECT id, email FROM Employee WHERE id LIKE 'zz-totp%' OR email LIKE 'zz-totp%'",
    );
    console.log(leftovers.length ? leftovers : 'Keine Wegwerfkonten mehr da.');

    const enrolled: any[] = await prisma.$queryRawUnsafe(
        'SELECT COUNT(*) AS gesamt, SUM(CASE WHEN totpEnabledAt IS NOT NULL THEN 1 ELSE 0 END) AS eingerichtet FROM Employee',
    );
    console.log('Personen:', enrolled[0]);

    await prisma.$disconnect();
};

void main().catch((error) => {
    console.error('FEHLER:', error.message);
    process.exit(1);
});
