const endpoints = [
  ["POST", "/api/uploads/sessions", "Create a chunked upload session."],
  ["PUT", "/api/uploads/{uploadId}/chunks/{index}", "Stream one binary chunk."],
  ["POST", "/api/uploads/{uploadId}/complete", "Merge, validate, scan, and store original."],
  ["POST", "/api/conversions", "Queue one or more real conversion jobs."],
  ["POST", "/api/conversions/ai", "Queue OCR, summary, transcription, subtitle, upscaling, background removal, analysis, or repair."],
  ["GET", "/api/conversions/history", "Fetch user conversion history."],
  ["POST", "/api/conversions/zip", "Stream completed outputs as a ZIP archive."],
  ["GET", "/ws", "Receive job.progress WebSocket events."]
];

export default function ApiDocsPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6 lg:px-8">
      <p className="text-xs font-bold uppercase tracking-[0.28em] text-neon-cyan">Developer Surface</p>
      <h1 className="mt-2 text-4xl font-black text-white">API Docs</h1>
      <div className="mt-8 overflow-hidden rounded-2xl border border-line">
        {endpoints.map(([method, path, text]) => (
          <div key={path} className="grid gap-3 border-b border-line bg-white/[0.03] p-4 text-sm last:border-b-0 md:grid-cols-[80px_1fr_1.2fr]">
            <span className="font-black text-neon-cyan">{method}</span>
            <code className="text-slate-200">{path}</code>
            <span className="text-slate-400">{text}</span>
          </div>
        ))}
      </div>
      <pre className="mt-6 overflow-auto rounded-2xl border border-line bg-ink p-5 text-xs leading-6 text-slate-300 scrollbar-thin">{`curl -X POST "$API_URL/api/conversions" \\
  -H "x-api-key: ocai_..." \\
  -H "content-type: application/json" \\
  -d '{"files":[{"uploadId":"...","targetFormat":"pdf","options":{"quality":86}}]}'`}</pre>
    </div>
  );
}
