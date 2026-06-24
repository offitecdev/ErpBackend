import {CustomerActivity} from "../entities/CustomerActivitiy";

export interface ITimeLineFilter{
    activityType?: string;
    startDate?: Date ;
    endDate ? : Date;
}

export interface ICustomerActivityRepository{
    create(activity : Partial<CustomerActivity>) : Promise<CustomerActivity>;
    getCustomerActivities(customerId : string, filter? : ITimeLineFilter) : Promise<CustomerActivity[]>;
    getActivitiesByReference(referenceId: string): Promise<any[]>;
    findById(id: string): Promise<CustomerActivity | null>;
    update(id: string, activity: Partial<CustomerActivity>): Promise<CustomerActivity>;
    delete(id: string): Promise<void>;
}

