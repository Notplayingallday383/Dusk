// Demo-mode entrypoint. Kept separate from src/index.ts so importing the
// library (src/index.ts) has zero side effects: no DOM access, no auto-start.
// index.html loads this file directly in app mode.

if (typeof document !== 'undefined') {
	void (async () => {
		const params = new URLSearchParams(location.search);
		if (params.get('demo') === 'scripted') {
			const { startScripted } = await import('./scripted');
			await startScripted();
		} else {
			const { startPage } = await import('./page');
			await startPage();
		}
	})();
}
