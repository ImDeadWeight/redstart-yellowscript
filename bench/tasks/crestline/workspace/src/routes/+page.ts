import type { PageLoad } from './$types';
import { services } from '$lib/catalog';

export const load: PageLoad = () => {
	return { services };
};
