/* Eine ANGEMELDETE Seite ablichten. Das Zugangsmerkmal wird mit dem eigenen
   Dienst des Servers ausgestellt und als Keks gesetzt — kein Kennwort wird
   angefasst; das Merkmal laeuft nach 15 Minuten von selbst ab.

   Aufruf: node scratchpad/shot-app.js <pfad> <ziel.png> [breite] [hoehe] [lang] [theme]
     <pfad> ist der Weg IN der Anwendung, z. B. /crm/enquiries
*/
require('dotenv/config');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const CHROME = path.join('C:', 'Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe');
const PORT = 9341;
const APP = 'http://localhost:5173';
const [, , appPath, out, wRaw, hRaw, lang, theme, clickSel] = process.argv;
const W = Number(wRaw || 1440);
const H = Number(hRaw || 950);
const LANG = lang || 'de';
const THEME = theme || 'light';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (p) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
});

(async () => {
    // Merkmal ausstellen (dieselben Bausteine wie der Server selbst benutzt).
    const { PrismaClient } = require('@prisma/client');
    const prisma = require('../src/infrastructure/database/prisma.client').default;
    const { jwtTokenService, toPwdAtClaim } = require('../src/infrastructure/services/JwtTokenService');

    // Fuer /montage zaehlt nicht CRM, sondern moeglichst VIEL Recht: die Rolle
    // mit den meisten Berechtigungen (der Verwaltungszugang).
    const roles = await prisma.role.findMany({
        select: { id: true, _count: { select: { permissions: true } } },
    });
    roles.sort((a, b) => b._count.permissions - a._count.permissions);
    const okRoleIds = roles.slice(0, 4).map((role) => role.id);
    const user = await prisma.employee.findFirst({
        where: process.env.OFI_SHOT_EMAIL ? { email: process.env.OFI_SHOT_EMAIL } : { deletedAt: null, bannedAt: null, isActive: true, employeeRoles: { some: { roleId: { in: okRoleIds } } }, ...(process.env.OFI_SHOT_TENANT ? { tenantId: process.env.OFI_SHOT_TENANT } : {}) },
        orderBy: { createdAt: 'asc' },
        select: { id: true, email: true, tenantId: true, passwordChangedAt: true },
    });
    if (!user) throw new Error('kein Konto mit Rechten');
    const access = jwtTokenService.generateToken('access', {
        id: user.id, tenantId: user.tenantId, email: user.email, pwdAt: toPwdAtClaim(user.passwordChangedAt),
    });
    const csrf = crypto.randomBytes(32).toString('hex');
    await prisma.$disconnect();
    console.log('Als:', user.email);

    const chrome = spawn(CHROME, [
        '--headless=new',
        '--remote-debugging-port=' + PORT,
        '--window-size=' + W + ',' + H,
        '--hide-scrollbars',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--user-data-dir=' + path.join(os.tmpdir(), 'ofi-shot-montage'),
        'about:blank',
    ], { stdio: 'ignore' });

    let targets = null;
    for (let i = 0; i < 60 && !targets; i += 1) {
        await sleep(300);
        try { targets = await getJson('/json/list'); } catch (e) { /* noch nicht da */ }
    }
    if (!targets) throw new Error('Chrome antwortet nicht');
    const page = targets.find((t) => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    let id = 0;
    const pending = new Map();
    ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    };
    const send = (method, params) => new Promise((resolve) => {
        const mid = ++id;
        pending.set(mid, resolve);
        ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
    });
    await new Promise((r) => { ws.onopen = r; });

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: false });

    // Kekse fuer BEIDE Ursprünge: die Seite laeuft auf 5173, der Server auf 3000.
    for (const domain of ['localhost']) {
        for (const [name, value, httpOnly] of [['ofi_access', access, true], ['ofi_csrf', csrf, false]]) {
            await send('Network.setCookie', { name, value, domain, path: '/', httpOnly, sameSite: 'Lax' });
        }
    }

    /* Sprache, Farbschema und der Sitzungs-Merker muessen stehen, BEVOR das
       erste Skript der Anwendung laeuft — sonst zeigt der erste Aufruf die
       Anmeldeseite, `fetchProfile` faellt durch und raeumt den Merker wieder
       weg. Darum als Vorlade-Skript und nicht als Runtime.evaluate danach. */
    await send('Page.addScriptToEvaluateOnNewDocument', {
        source: 'try{localStorage.setItem("theme","' + THEME + '");'
            + 'localStorage.setItem("offitec:lang","' + LANG + '");'
            /* Das Neuigkeiten-Fenster legt sich sonst ueber jedes Bild: alle
               Mitteilungen gelten als gelesen, fuer JEDEN Schluessel. */
            + 'var SEEN=JSON.stringify(["update-2026-08-29","update-2026-08-19","update-2026-08-17","update-2026-08-15","update-2026-08-07","prototype-2026-07-24"]);'
            + 'var _g=localStorage.getItem.bind(localStorage);'
            + 'localStorage.getItem=function(k){return String(k).indexOf("offitec-updates-seen")===0?SEEN:_g(k);};'
            + 'localStorage.setItem("ofi_has_session","1");}catch(e){}',
    });
    console.log('--- Ziel ---', JSON.stringify(APP + appPath));
    const navResult = await send('Page.navigate', { url: APP + appPath });
    console.log('--- navigate ---', JSON.stringify(navResult.result || navResult.error));
    await sleep(9000);

    /* Optional: vor dem Bild etwas anklicken (z. B. das Apps-Zeichen), damit
       auch aufgeklappte Felder abgelichtet werden koennen. */
    if (clickSel) {
        // Mehrere Schritte hintereinander: mit `||` getrennt. Ein Schritt, der mit
        // `focus:` beginnt, wird angeklickt UND fokussiert (Trefferlisten oeffnen
        // sich am Fokus, nicht am Klick).
        for (const step of clickSel.split('||')) {
            const focusMode = step.startsWith('focus:');
            const sel = focusMode ? step.slice(6) : step;
            const clicked = await send('Runtime.evaluate', {
                expression: '(function(){var el=document.querySelector(' + JSON.stringify(sel) + ');if(!el)return "nicht gefunden";'
                    + (focusMode ? 'el.focus();el.dispatchEvent(new FocusEvent("focusin",{bubbles:true}));' : 'el.click();')
                    + 'return "ok";})()',
                returnByValue: true,
            });
            console.log('--- Klick ---', sel, (clicked.result && clicked.result.result && clicked.result.result.value) || '?');
            await sleep(1800);
        }
        await sleep(900);
    }
    const where = await send('Runtime.evaluate', { expression: 'location.pathname', returnByValue: true });
    console.log('--- Ort ---', (where.result && where.result.result && where.result.result.value) || '?');
    const diag = await send('Runtime.evaluate', {
        expression: 'fetch("http://localhost:3000/api/v1/auth/me/permissions",{credentials:"include"}).then(r=>r.json()).then(d=>JSON.stringify({status:"ok", keys:Object.keys(d.pageAccess||{}).length, enq:(d.pageAccess||{})["crm.enquiries"], act:(d.pageAccess||{})["crm.activities"]})).catch(e=>"FEHLER "+e.message)',
        returnByValue: true, awaitPromise: true,
    });
    console.log('--- Karte im Browser ---', JSON.stringify(diag.result && diag.result.result && diag.result.result.value));
    if (process.env.OFI_EVAL) {
        const extra = await send('Runtime.evaluate', { expression: process.env.OFI_EVAL, returnByValue: true });
        console.log('--- Eval ---', JSON.stringify(extra.result && extra.result.result && extra.result.result.value));
    }
    const text = await send('Runtime.evaluate', { expression: 'document.body.innerText.slice(0,1400)', returnByValue: true });
    console.log('--- Text ---');
    console.log((text.result && text.result.result && text.result.result.value) || '(leer)');

    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
    console.log('gespeichert:', out);

    ws.close();
    chrome.kill();
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
