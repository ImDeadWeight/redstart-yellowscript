// Crestline Facility Care's services: what each facility type costs per
// square foot per visit, and how much one cleaner covers in an hour.

export type FacilityType = 'office' | 'medical' | 'retail' | 'warehouse';

export interface Service {
	id: FacilityType;
	name: string;
	ratePerSqFt: number;
	sqFtPerHour: number;
}

export const services: Service[] = [
	{ id: 'office', name: 'Office cleaning', ratePerSqFt: 0.12, sqFtPerHour: 2500 },
	{ id: 'medical', name: 'Medical facility cleaning', ratePerSqFt: 0.22, sqFtPerHour: 1500 },
	{ id: 'retail', name: 'Retail store cleaning', ratePerSqFt: 0.1, sqFtPerHour: 3000 },
	{ id: 'warehouse', name: 'Warehouse cleaning', ratePerSqFt: 0.06, sqFtPerHour: 5000 }
];
