"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runTasksTransaction = exports.tasksDb = void 0;
const prisma_client_1 = __importDefault(require("../../../infrastructure/database/prisma.client"));
exports.tasksDb = prisma_client_1.default;
/**
 * Eine Transaktion mit Zeitreserve für die ferne Datenbank (~50–170 ms je
 * Anweisung): Zustandswechsel sperren die Aufgabenzeile (`FOR UPDATE`) und
 * brauchen darum mehrere Rundgänge in EINER Verbindung.
 */
const runTasksTransaction = (work) => prisma_client_1.default.$transaction((tx) => work(tx), { maxWait: 10_000, timeout: 30_000 });
exports.runTasksTransaction = runTasksTransaction;
//# sourceMappingURL=taskDb.js.map