import prisma from '../src/infrastructure/database/prisma.client';
import { decryptTotpSecret } from '../src/infrastructure/services/totpCrypto';
import { currentTotpStep, totpCodeForStep } from '../src/shared/totp';

const run = async (): Promise<void> => {
    const employee = await prisma.employee.findUnique({
        where: { email: 'admin@offitec.com' },
        select: { totpSecret: true, totpLastStep: true },
    });
    const secret = decryptTotpSecret(employee?.totpSecret);
    if (!secret) throw new Error('Test account has no TOTP secret');
    const now = currentTotpStep();
    const step = employee?.totpLastStep !== null && employee?.totpLastStep !== undefined && now <= employee.totpLastStep
        ? employee.totpLastStep + 1
        : now;
    // Never print or persist the secret. The six-digit code is valid only for
    // its current 30-second window and is consumed by the login probe.
    process.stdout.write(JSON.stringify({ code: totpCodeForStep(secret, step), waitMs: Math.max(0, step * 30_000 - Date.now()) }));
};

run().finally(() => prisma.$disconnect());
