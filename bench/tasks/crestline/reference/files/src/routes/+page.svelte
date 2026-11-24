<script lang="ts">
	import type { PageProps } from './$types';
	import { ADD_ONS, PRESETS, calculateQuote, type AddOnId, type FacilityType, type Frequency } from '$lib/quote';

	let { data }: PageProps = $props();

	let squareFootage = $state(2000);
	let facilityType = $state<FacilityType>('office');
	let frequency = $state<Frequency>('weekly');
	let addOns = $state<AddOnId[]>([]);

	const frequencies: Frequency[] = ['weekly', 'biweekly', 'nightly'];
	const presetNames = Object.keys(PRESETS) as (keyof typeof PRESETS)[];

	const quote = $derived(calculateQuote({ squareFootage, facilityType, frequency, addOns }));
	const money = (n: number) => `$${n.toFixed(2)}`;

	function applyPreset(name: keyof typeof PRESETS) {
		const preset = PRESETS[name];
		squareFootage = preset.squareFootage;
		facilityType = preset.facilityType;
		frequency = preset.frequency;
		addOns = [...preset.addOns];
	}

	function toggle(id: AddOnId) {
		addOns = addOns.includes(id) ? addOns.filter((a) => a !== id) : [...addOns, id];
	}
</script>

<h1>Crestline Facility Care</h1>

<h2>Our services</h2>
<ul class="services">
	{#each data.services as item (item.id)}
		<li>{item.name}</li>
	{/each}
</ul>

<h2>Get a quote</h2>
<div class="presets">
	{#each presetNames as name (name)}
		<button type="button" onclick={() => applyPreset(name)}>{name}</button>
	{/each}
</div>

<label>
	Square footage
	<input type="number" min="0" step="100" bind:value={squareFootage} />
</label>

<label>
	Facility type
	<select bind:value={facilityType}>
		{#each data.services as service (service.id)}
			<option value={service.id}>{service.name}</option>
		{/each}
	</select>
</label>

<fieldset>
	<legend>Frequency</legend>
	{#each frequencies as f (f)}
		<label><input type="radio" name="frequency" value={f} bind:group={frequency} /> {f}</label>
	{/each}
</fieldset>

<fieldset>
	<legend>Add-ons</legend>
	{#each ADD_ONS as addOn (addOn.id)}
		<label><input type="checkbox" checked={addOns.includes(addOn.id)} onchange={() => toggle(addOn.id)} /> {addOn.label}</label>
	{/each}
</fieldset>

<section class="quote">
	<ul>
		{#each quote.items as item (item.label)}
			<li>{item.label}: {money(item.amount)}</li>
		{/each}
	</ul>
	<p><strong>Total per visit: {money(quote.total)}</strong></p>
	<p>Estimated hours: {quote.hours}</p>
</section>
