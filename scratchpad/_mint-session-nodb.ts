// Re-signs an EXPIRED dev session without touching the database: reads the
// claims of a previous session.json (argv[3]) and mints a fresh access token
// with the app's own JwtTokenService. Usage:
//   npx ts-node --transpile-only scratchpad/_mint-session-nodb.ts <out.json> <old.json>
import dotenv from 'dotenv';
dotenv.config({ path: `${__dirname}/../.env` });
import { readFileSync, writeFileSync } from 'fs';
import { jwtTokenService } from '../src/infrastructure/services/JwtTokenService';

const [out, oldPath] = process.argv.slice(2);
const old = JSON.parse(readFileSync(oldPath, 'utf8'));
const payload = JSON.parse(Buffer.from(old.access.split('.')[1], 'base64url').toString('utf8'));
const { id, tenantId, email, pwdAt } = payload;
const access = jwtTokenService.generateToken('access', { id, tenantId, email, pwdAt } as any);
writeFileSync(out, JSON.stringify({ access, tenantId }));
console.log('minted for', email, tenantId, 'claims:', Object.keys(payload).join(','));
