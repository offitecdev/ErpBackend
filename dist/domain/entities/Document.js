"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Document = void 0;
class Document {
    id;
    tenantId;
    relatedEntityId;
    entityType;
    fileName;
    fileUrl;
    uploadedByEmployeeId;
    fileType;
    category;
    constructor(id, tenantId, relatedEntityId, entityType, fileName, fileUrl, uploadedByEmployeeId, fileType, category) {
        this.id = id;
        this.tenantId = tenantId;
        this.relatedEntityId = relatedEntityId;
        this.entityType = entityType;
        this.fileName = fileName;
        this.fileUrl = fileUrl;
        this.uploadedByEmployeeId = uploadedByEmployeeId;
        this.fileType = fileType;
        this.category = category;
    }
}
exports.Document = Document;
//# sourceMappingURL=Document.js.map