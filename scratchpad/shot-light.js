/* Wie shot.js, aber setzt VOR dem Laden Sprache und Farbschema im Speicher des
   Browsers — sonst zeigt der kopflose Chrome die Voreinstellung des Systems
   (dunkel) und die Sprache des Rechners.

   Aufruf: node scratchpad/shot-light.js <url> <ziel.png> [breite] [hoehe] [lang] [theme]
*/
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const os = require('os');

const CHROME = path.join('C:', 'Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe');
const PORT = 9334;
const [, , url, out, wRaw, hRaw, lang, theme] = process.argv;
const W = Number(wRaw || 1440);
const H = Number(hRaw || 1000);
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
    const origin = new URL(url).origin;
    const chrome = spawn(CHROME, [
        '--headless=new',
        '--remote-debugging-port=' + PORT,
        '--window-size=' + W + ',' + H,
        '--hide-scrollbars',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--user-data-dir=' + path.join(os.tmpdir(), 'ofi-shot-profile2'),
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
    await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: false });

    // Erst den Ursprung oeffnen, damit localStorage schreibbar ist ...
    await send('Page.navigate', { url: origin + '/login' });
    await sleep(2500);
    await send('Runtime.evaluate', {
        expression: 'localStorage.setItem("theme", "' + THEME + '"); localStorage.setItem("offitec:lang", "' + LANG + '"); "ok"',
        returnByValue: true,
    });
    // ... dann die eigentliche Seite.
    await send('Page.navigate', { url });
    await sleep(4000);

    const text = await send('Runtime.evaluate', { expression: 'document.body.innerText.slice(0,900)', returnByValue: true });
    console.log('--- Text ---');
    console.log((text.result && text.result.result && text.result.result.value) || '(leer)');

    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
    console.log('gespeichert:', out);

    ws.close();
    chrome.kill();
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
