export class CustomerContact{
    constructor(
        public id: string ,
        public customerId: string ,
        public firstName: string ,
        public lastName: string ,
        public isPrimaryContact : boolean,
        public title? : string | null ,
        public phone? : string | null ,
        public email? : string | null ,
    ) {}


}