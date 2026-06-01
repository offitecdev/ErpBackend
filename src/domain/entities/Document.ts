export class Document{
    constructor(
        public id : string,
        public tenantId : string,
        public relatedEntityId : string,
        public entityType : string,
        public fileName : string,   
        public fileUrl : string,
        public uploadedByEmployeeId : string,
        public fileType?: string | null,
        public category? : string | null,
    ) {}
}