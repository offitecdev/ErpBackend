const fs = require('fs');
const path = require('path');
const os = require('os');
const Module = require('module');
const { execFileSync } = require('child_process');

const distEntry = path.join(__dirname, 'dist', 'main.js');
const prismaGenerateLock = path.join(__dirname, '.prisma-generate.lock');

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

function sleep(ms) {
    const buffer = new SharedArrayBuffer(4);
    const view = new Int32Array(buffer);
    Atomics.wait(view, 0, 0, ms);
}

function getPrismaNodeModulesDir() {
    try {
        const prismaClientEntry = require.resolve('@prisma/client/default.js', {
            paths: [__dirname],
        });
        return path.resolve(prismaClientEntry, '..', '..', '..');
    } catch {
        return path.join(__dirname, 'node_modules');
    }
}

function getPrismaClientPaths() {
    const nodeModulesDir = getPrismaNodeModulesDir();

    return {
        packageEntry: path.join(nodeModulesDir, '@prisma', 'client', 'default.js'),
        generatedEntry: path.join(nodeModulesDir, '.prisma', 'client', 'index.js'),
        generatedDefaultEntry: path.join(nodeModulesDir, '.prisma', 'client', 'default.js'),
    };
}

function hasGeneratedPrismaClient() {
    const prismaClientPaths = getPrismaClientPaths();

    return (
        fs.existsSync(prismaClientPaths.packageEntry) &&
        fs.existsSync(prismaClientPaths.generatedEntry) &&
        fs.existsSync(prismaClientPaths.generatedDefaultEntry)
    );
}

function isMissingPrismaClientError(error) {
    const message = error && error.message ? error.message : '';
    const code = error && error.code ? error.code : '';

    return (
        code === 'MODULE_NOT_FOUND' &&
        (message.includes('.prisma/client') ||
            message.includes('.prisma\\client') ||
            message.includes('@prisma/client') ||
            message.includes('@prisma\\client'))
    );
}

function waitForPrismaClient(timeoutMs = 120000) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
        if (hasGeneratedPrismaClient()) {
            return true;
        }

        sleep(500);
    }

    return hasGeneratedPrismaClient();
}

function acquirePrismaGenerateLock() {
    try {
        const lockHandle = fs.openSync(prismaGenerateLock, 'wx');
        fs.writeFileSync(lockHandle, `${process.pid}\n${new Date().toISOString()}\n`);
        fs.closeSync(lockHandle);
        return true;
    } catch (error) {
        if (error && error.code !== 'EEXIST') {
            throw error;
        }

        try {
            const lockAgeMs = Date.now() - fs.statSync(prismaGenerateLock).mtimeMs;
            if (lockAgeMs > 120000) {
                fs.unlinkSync(prismaGenerateLock);
                return acquirePrismaGenerateLock();
            }
        } catch (statError) {
            if (statError && statError.code === 'ENOENT') {
                return acquirePrismaGenerateLock();
            }
            throw statError;
        }

        return false;
    }
}

function releasePrismaGenerateLock() {
    try {
        fs.unlinkSync(prismaGenerateLock);
    } catch (error) {
        if (!error || error.code !== 'ENOENT') {
            throw error;
        }
    }
}

function generatePrismaClient() {
    if (hasGeneratedPrismaClient()) {
        return;
    }

    if (!acquirePrismaGenerateLock()) {
        console.error('[OFFITEC] Prisma Client uretiliyor; mevcut islem bekleniyor...');
        if (!waitForPrismaClient()) {
            throw new Error('[OFFITEC] Prisma Client uretilirken zaman asimi olustu.');
        }
        return;
    }

    try {
        console.error('[OFFITEC] Prisma Client bulunamadi. "prisma generate" calistiriliyor...');
        const prismaCli = require.resolve('prisma/build/index.js', {
            paths: [__dirname, getPrismaNodeModulesDir()],
        });
        execFileSync(process.execPath, [prismaCli, 'generate', '--schema', path.join(__dirname, 'prisma', 'schema')], {
            cwd: __dirname,
            stdio: 'inherit',
            env: process.env,
        });

        if (!hasGeneratedPrismaClient()) {
            throw new Error('[OFFITEC] "prisma generate" tamamlandi ancak Prisma Client dosyalari bulunamadi.');
        }

        console.error('[OFFITEC] Prisma Client olusturuldu.');
    } finally {
        releasePrismaGenerateLock();
    }
}

function ensurePrismaClient() {
    try {
        require('@prisma/client');
    } catch (error) {
        if (!isMissingPrismaClientError(error)) {
            throw error;
        }

        generatePrismaClient();
        require('@prisma/client');
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
