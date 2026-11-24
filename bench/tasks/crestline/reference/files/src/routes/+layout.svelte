<script lang="ts">
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();
</script>

<header>
	<strong>Crestline Facility Care</strong>
	<span>Commercial cleaning quotes</span>
</header>

<main>
	{@render children()}
</main>

<style>
	header {
		display: flex;
		gap: 1rem;
		align-items: baseline;
		padding: 1rem 2rem;
		border-bottom: 1px solid #ddd;
	}
	main {
		padding: 1rem 2rem;
	}
</style>
