const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const distEntry = path.join(__dirname, 'dist', 'main.js');

function ensurePrismaClient() {
    try {
        require('@prisma/client/default');
    } catch (error) {
        const message = error && error.message ? error.message : '';
        if (!message.includes('.prisma/client')) {
            throw error;
        }

        console.error('[OFFITEC] Prisma Client bulunamadi. "prisma generate" calistiriliyor...');
        const prismaCli = require.resolve('prisma/build/index.js');
        execFileSync(process.execPath, [prismaCli, 'generate'], {
            cwd: __dirname,
            stdio: 'inherit',
            env: process.env,
        });
    }
}

ensurePrismaClient();

if (fs.existsSync(distEntry)) {
    require(distEntry);
} else {
    try {
        require('ts-node/register/transpile-only');
        require('./src/main.ts');
    } catch (error) {
        console.error('[OFFITEC] dist/main.js bulunamadi ve ts-node yuklu degil.');
        console.error('[OFFITEC] Sunucuda once "npm install" ve "npm run build" calistirin veya dist klasorunu yukleyin.');
        throw error;
    }
}
