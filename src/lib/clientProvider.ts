// Filled from the authenticated bootstrap before mounting the dashboard.
let version = 'unverified';
let configured = false;
export function setClientProvider(value: { version?: string; configured?: boolean }) { version=value.version??'unverified';configured=Boolean(value.configured); }
export function clientProviderVersion() { return version; }
export function clientAIConfigured() { return configured; }
