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
        public mainEmail? : string | null ,
        public customerType : string = "PRIVATE",
        public mobilePhone? : string | null ,
        public website? : string | null ,
        public language? : string | null ,
        public vatNumber? : string | null ,
        public customerSource? : string | null ,
        public responsibleFirstName? : string | null ,
        public responsibleLastName? : string | null ,
        public status : string = "ACTIVE",
        public priceList? : string | null ,
        public addressName? : string | null ,
        public postalCode? : string | null ,
        public city? : string | null ,
        public country? : string | null
    ) {}
}