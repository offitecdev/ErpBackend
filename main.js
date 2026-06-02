const fs = require('fs');
const path = require('path');

const distEntry = path.join(__dirname, 'dist', 'main.js');

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
