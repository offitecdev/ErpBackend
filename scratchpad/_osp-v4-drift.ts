import dotenv from 'dotenv';
dotenv.config({ path: `${__dirname}/../.env` });
import '../src/infrastructure/database/prisma.client';
import { spawnSync } from 'child_process';
const r = spawnSync('npx', ['prisma', 'migrate', 'diff',
    '--from-config-datasource',
    '--to-schema', 'prisma/schema', '--script'],
    { cwd: `${__dirname}/..`, stdio: 'inherit', env: process.env, shell: true });
process.exit(r.status ?? 1);
