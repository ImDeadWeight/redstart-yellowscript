<script lang="ts">
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<h1>Crestline Facility Care</h1>

<h2>Our services</h2>
<ul class="services">
	{#each data.items as item (item.id)}
		<li>{item.name}</li>
	{/each}
</ul>
