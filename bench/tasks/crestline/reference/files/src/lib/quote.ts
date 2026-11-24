// Pricing and hours for Crestline Facility Care quotes.

import { services, type FacilityType } from './catalog';

export type { FacilityType };
export type Frequency = 'weekly' | 'biweekly' | 'nightly';
export type AddOnId = 'carpet-care' | 'window-washing' | 'restroom-deep-clean';

export interface QuoteInput {
	squareFootage: number;
	facilityType: FacilityType;
	frequency: Frequency;
	addOns: AddOnId[];
}

export interface LineItem {
	label: string;
	amount: number;
}

export interface Quote {
	items: LineItem[];
	total: number;
	hours: number;
}

/** Per-visit price: less often means more to clean each time. */
export const FREQUENCY_MULTIPLIERS: Record<Frequency, number> = {
	weekly: 1,
	biweekly: 1.15,
	nightly: 0.85
};

export interface AddOn {
	id: AddOnId;
	label: string;
	/** Per square foot, or a flat fee per visit. */
	perSqFt?: number;
	flat?: number;
	hours: number;
}

export const ADD_ONS: AddOn[] = [
	{ id: 'carpet-care', label: 'Carpet care', perSqFt: 0.03, hours: 1 },
	{ id: 'window-washing', label: 'Window washing', flat: 150, hours: 1.5 },
	{ id: 'restroom-deep-clean', label: 'Restroom deep clean', flat: 95, hours: 1 }
];

export const PRESETS: Record<'Small Office' | 'Medical Clinic', QuoteInput> = {
	'Small Office': { squareFootage: 2000, facilityType: 'office', frequency: 'weekly', addOns: [] },
	'Medical Clinic': { squareFootage: 5000, facilityType: 'medical', frequency: 'nightly', addOns: ['restroom-deep-clean'] }
};

const round2 = (n: number) => Math.round(n * 100) / 100;

export function calculateQuote(input: QuoteInput): Quote {
	const service = services.find((s) => s.id === input.facilityType);
	if (!service) throw new Error(`Unknown facility type: ${input.facilityType}`);
	const sqFt = Math.max(0, input.squareFootage);
	const multiplier = FREQUENCY_MULTIPLIERS[input.frequency];

	const items: LineItem[] = [{ label: `${service.name} (${input.frequency})`, amount: round2(sqFt * service.ratePerSqFt * multiplier) }];
	let hours = sqFt / service.sqFtPerHour;
	for (const addOn of ADD_ONS) {
		if (!input.addOns.includes(addOn.id)) continue;
		items.push({ label: addOn.label, amount: round2(addOn.perSqFt !== undefined ? sqFt * addOn.perSqFt : (addOn.flat ?? 0)) });
		hours += addOn.hours;
	}
	return { items, total: round2(items.reduce((sum, item) => sum + item.amount, 0)), hours: round2(hours) };
}
