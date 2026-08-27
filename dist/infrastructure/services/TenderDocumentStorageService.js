"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.tenderDocumentStorageService = void 0;
const path_1 = __importDefault(require("path"));
const LocalFileStorage_1 = require("./LocalFileStorage");
/**
 * Keeps attachment bytes out of MariaDB. The database stores only an opaque,
 * short reference while the binary is written to a persistent local volume.
 *
 * Die Mechanik selbst steht seit 24.08.2026 in `LocalFileStorage` — sie wird
 * inzwischen auch von den Terminunterlagen gebraucht. Der Verweis-Vorsatz
 * `local:tender-document/` bleibt unverändert: er steht so in jeder Zeile, die
 * es schon gibt.
 */
exports.tenderDocumentStorageService = new LocalFileStorage_1.LocalFileStorage({
    prefix: 'local:tender-document/',
    directory: process.env.OFFITEC_TENDER_UPLOAD_DIR
        || path_1.default.join(process.cwd(), 'storage', 'tender-documents'),
});
//# sourceMappingURL=TenderDocumentStorageService.js.map