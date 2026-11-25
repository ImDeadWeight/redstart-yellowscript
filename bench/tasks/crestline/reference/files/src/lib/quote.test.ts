import { describe, expect, it } from 'vitest';

import { calculateQuote, FREQUENCY_MULTIPLIERS, PRESETS } from './quote';

describe('presets', () => {
	it('prices a small office weekly at the office rate', () => {
		const quote = calculateQuote(PRESETS['Small Office']);
		expect(quote.total).toBe(240);
		expect(quote.hours).toBe(0.8);
	});

	it('prices a medical clinic nightly with a restroom deep clean', () => {
		const quote = calculateQuote(PRESETS['Medical Clinic']);
		expect(quote.items.map((i) => i.label)).toContain('Restroom deep clean');
		expect(quote.total).toBe(1030);
	});
});

describe('add-ons', () => {
	it('adds carpet care per square foot and window washing as a flat fee', () => {
		const base = calculateQuote({ squareFootage: 1000, facilityType: 'retail', frequency: 'weekly', addOns: [] });
		const withAddOns = calculateQuote({ squareFootage: 1000, facilityType: 'retail', frequency: 'weekly', addOns: ['carpet-care', 'window-washing'] });
		expect(withAddOns.total - base.total).toBe(180);
		expect(withAddOns.hours - base.hours).toBeCloseTo(2.5, 2);
	});
});

describe('frequency multipliers', () => {
	it('scales the base price by frequency', () => {
		const input = { squareFootage: 10000, facilityType: 'warehouse' as const, addOns: [] };
		for (const frequency of ['weekly', 'biweekly', 'nightly'] as const) {
			expect(calculateQuote({ ...input, frequency }).total).toBe(Math.round(600 * FREQUENCY_MULTIPLIERS[frequency] * 100) / 100);
		}
	});
});
