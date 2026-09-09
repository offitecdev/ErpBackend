/* Migration `20260922090000_auth_hardening` gegen die entfernte Datenbank
   ausspielen (Employee.deactivatedAt + Tabelle RefreshSession). Die Zugangsdaten
   liegen verschlüsselt in .env; prisma.client baut daraus DATABASE_URL — damit
   läuft `prisma migrate deploy` als Kindprozess. Gleiches Vorgehen wie bei
   apply-osp-md-migration.ts. */
import dotenv from 'dotenv';
dotenv.config({ path: `${__dirname}/../.env` });

import '../src/infrastructure/database/prisma.client';
import { spawnSync } from 'child_process';

const result = spawnSync('npx', ['prisma', 'migrate', 'deploy', '--schema', 'prisma/schema'], {
    cwd: `${__dirname}/..`,
    stdio: 'inherit',
    env: process.env,
    shell: true,
});
process.exit(result.status ?? 1);
