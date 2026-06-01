export class Customer {
    constructor(
        public id: string ,
        public tenantId: string ,
        public companyName: string ,
        public isActive : boolean,
        public segment? : string | null , 
        public taxOffice? : string | null ,
        public taxNumber? : string | null ,
        public address? : string | null ,
        public mainPhone? : string | null ,
        public mainEmail? : string | null 
    ) {}
}