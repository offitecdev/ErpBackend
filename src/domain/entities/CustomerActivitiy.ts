export class CustomerActivity{
    constructor(
        public id : string,
        public customerId : string,
        public employeeId : string,
        public activityType : string,
        public activityDate : Date,
        public description? : string | null,
        public referenceId? : string | null 

    ){}
}