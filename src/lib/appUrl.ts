/** Resolve the public origin in local, Preview, and Production environments. */
export function getAppUrl(): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (configured && !/localhost|127\.0\.0\.1/.test(configured)) {
    return configured.replace(/\/$/, "");
  }

  const vercelHost = process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL;
  if (vercelHost) return `https://${vercelHost.replace(/^https?:\/\//, "").replace(/\/$/, "")}`;

  return "http://localhost:3000";
}
