const fs = require('fs');
const path = require('path');
const os = require('os');
const Module = require('module');
const { execFileSync } = require('child_process');

const distEntry = path.join(__dirname, 'dist', 'main.js');

function registerNodePaths() {
    const paths = [];
    const homeDir = process.env.HOME || os.homedir();
    const nodeMajor = process.versions.node.split('.')[0];
    const publicHtmlDir = path.join(homeDir, 'public_html');
    const appRelativePath = path.relative(publicHtmlDir, __dirname);

    if (process.env.VIRTUAL_ENV) {
        paths.push(path.join(process.env.VIRTUAL_ENV, 'lib', 'node_modules'));
    }

    if (appRelativePath && !appRelativePath.startsWith('..') && !path.isAbsolute(appRelativePath)) {
        paths.push(path.join(homeDir, 'nodevenv', 'public_html', appRelativePath, nodeMajor, 'lib', 'node_modules'));
    }

    paths.push(path.join(__dirname, 'node_modules'));

    const currentNodePath = process.env.NODE_PATH ? process.env.NODE_PATH.split(path.delimiter) : [];
    const nextNodePath = [...new Set([...paths.filter((item) => fs.existsSync(item)), ...currentNodePath])];

    if (nextNodePath.length) {
        process.env.NODE_PATH = nextNodePath.join(path.delimiter);
        Module._initPaths();
    }
}

function ensurePrismaClient() {
    try {
        require('@prisma/client');
    } catch (error) {
        const message = error && error.message ? error.message : '';
        if (!message.includes('.prisma/client') && !message.includes('@prisma/client') && !message.includes('@prisma\\client')) {
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

registerNodePaths();
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
