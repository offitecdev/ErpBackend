"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CustomerNoteRepository = void 0;
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
const CustomerNote_1 = require("../../domain/entities/CustomerNote");
const nanoid_1 = require("nanoid");
class CustomerNoteRepository {
    maptoEntity(data) {
        return new CustomerNote_1.CustomerNote(data.id, data.customerId, data.createdByEmployeeId, data.noteText, data.noteType, data.isHighlight, data.firstName || '', data.lastName || '', data.telephone, data.email, data.createdAt);
    }
    async create(note) {
        const data = await prisma_client_1.default.customerNote.create({
            data: {
                id: note.id || (0, nanoid_1.nanoid)(8),
                customerId: note.customerId,
                createdByEmployeeId: note.createdByEmployeeId,
                noteText: note.noteText,
                noteType: note.noteType,
                isHighlight: note.isHighlight ?? false,
                firstName: note.firstName || '',
                email: note.email || null,
                telephone: note.phone || null
            }
        });
        return this.maptoEntity(data);
    }
    async findByCustomerId(customerId) {
        const data = await prisma_client_1.default.customerNote.findMany({
            where: { customerId },
            orderBy: { createdAt: 'desc' }
        });
        return data.map(this.maptoEntity.bind(this));
    }
    async getHighlightedNotes(customerId) {
        const data = await prisma_client_1.default.customerNote.findMany({
            where: { customerId,
                isHighlight: true
            },
            orderBy: { createdAt: 'desc' }
        });
        return data.map(this.maptoEntity.bind(this));
    }
}
exports.CustomerNoteRepository = CustomerNoteRepository;
//# sourceMappingURL=CustomerNoteRepository.js.map