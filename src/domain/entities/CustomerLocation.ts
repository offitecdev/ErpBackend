export class CustomerLocation {
    constructor(
        public id: string,
        public customerId: string,
        public name: string,
        public isPrimary: boolean,
        public kind: string = "INSTALLATION",
        public address?: string | null,
        public city?: string | null,
        public postalCode?: string | null,
        public country?: string | null,
        public phone?: string | null,
        public email?: string | null,
        public contactPerson?: string | null,
        public notes?: string | null,
        public createdAt?: Date,
        public updatedAt?: Date,
    ) {}
}
