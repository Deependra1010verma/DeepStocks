'use client';

export default function ErrorPage({ retry }: { error: unknown; retry: () => void }) {
  return <main className="min-h-dvh bg-slate-950 text-slate-200 flex flex-col items-center justify-center gap-4 p-6 text-center">
    <h1 className="text-xl font-semibold">Dashboard could not load</h1>
    <p className="max-w-md text-slate-400">A request or application asset was interrupted. Retry once, or reload to get the current application version.</p>
    <div className="flex gap-4"><button className="rounded-lg bg-cyan-800 px-4 py-2" onClick={retry}>Try again</button><button className="rounded-lg bg-slate-800 px-4 py-2" onClick={()=>window.location.reload()}>Reload app</button></div>
  </main>;
}
