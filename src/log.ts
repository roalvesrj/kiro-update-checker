let sink: ((message: string) => void) | null = null;

export function setLogSink(fn: ((message: string) => void) | null): void {
	sink = fn;
}

export function log(message: string): void {
	console.log(`[KUC] ${message}`);
	if (sink) {
		sink(message);
	}
}
