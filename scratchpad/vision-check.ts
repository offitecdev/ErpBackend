import 'dotenv/config';
import { readFileSync } from 'node:fs';

/**
 * Was sagt Google WIRKLICH? Die Route verschluckt die Begruendung absichtlich
 * (sie kann Projektnummern enthalten); zum Einrichten braucht man sie aber.
 * Dieses Skript ruft Vision direkt und druckt Status und Meldung — der
 * Schluessel selbst wird nie ausgegeben.
 */
const main = async () => {
    const key = (process.env.OFFITEC_GOOGLE_VISION_API_KEY || '').trim();
    console.log('key present:', key.length > 0, '| length:', key.length, '| prefix:', key.slice(0, 4));

    const image = readFileSync('C:/ERP/offitec-camera.png').toString('base64');
    console.log('image base64 length:', image.length);

    const response = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(key)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            requests: [{
                image: { content: image },
                features: [{ type: 'TEXT_DETECTION' }],
                imageContext: { languageHints: ['de', 'en'] },
            }],
        }),
    });

    console.log('HTTP status:', response.status, response.statusText);
    const payload: any = await response.json().catch(() => null);

    if (payload?.error) {
        console.log('TOP-LEVEL ERROR');
        console.log('  status :', payload.error.status);
        console.log('  code   :', payload.error.code);
        console.log('  message:', payload.error.message);
        for (const detail of payload.error.details ?? []) console.log('  detail :', JSON.stringify(detail));
        return;
    }

    const first = payload?.responses?.[0];
    if (first?.error) {
        console.log('PER-IMAGE ERROR');
        console.log('  code   :', first.error.code);
        console.log('  message:', first.error.message);
        return;
    }

    const text = String(first?.fullTextAnnotation?.text ?? '');
    console.log('OK — text length:', text.length);
    console.log('first 200 chars:', JSON.stringify(text.slice(0, 200)));
};

void main();
