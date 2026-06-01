import { swaggerSpec } from '../src/infrastructure/config/swagger.config';
import * as fs from 'fs';
import * as path from 'path';

const outputPath = path.join(__dirname, '..', 'swagger-output.json');
fs.writeFileSync(outputPath, JSON.stringify(swaggerSpec, null, 2), 'utf-8');
console.log(`Swagger JSON exported to: ${outputPath}`);
