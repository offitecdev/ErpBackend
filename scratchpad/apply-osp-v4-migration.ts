/* OSP-Umbau (20.09.2026, vierte Vertragsfassung): die Migration
   `20260920090000_osp_contract_v4` gegen die entfernte Datenbank ausspielen.
   Die Zugangsdaten liegen verschlüsselt in .env; prisma.client baut daraus
   DATABASE_URL — damit läuft `prisma migrate deploy` als Kindprozess. */
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
