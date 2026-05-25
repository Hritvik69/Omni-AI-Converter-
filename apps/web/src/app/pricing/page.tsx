const plans = [
  ["Starter", "$19", "10 GB processing, standard queue, API access, signed links"],
  ["Studio", "$79", "100 GB processing, priority workers, AI tools, webhooks, presets"],
  ["Enterprise", "Custom", "Dedicated workers, private S3, SSO, VPC networking, compliance controls"]
];

export default function PricingPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6 lg:px-8">
      <p className="text-xs font-bold uppercase tracking-[0.28em] text-neon-cyan">Plans</p>
      <h1 className="mt-2 text-4xl font-black text-white">Pricing</h1>
      <div className="mt-8 grid gap-4 md:grid-cols-3">
        {plans.map(([name, price, text]) => (
          <section key={name} className="glass rounded-2xl p-6">
            <h2 className="text-xl font-black text-white">{name}</h2>
            <div className="mt-5 text-4xl font-black text-neon-cyan">{price}</div>
            <p className="mt-4 text-sm leading-7 text-slate-400">{text}</p>
          </section>
        ))}
      </div>
    </div>
  );
}
