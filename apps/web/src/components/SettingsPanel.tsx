"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { KeyRound, Plus, Trash2 } from "lucide-react";
import { apiFetch } from "../lib/api";

type ApiKey = {
  id: string;
  name: string;
  prefix: string;
  lastUsedAt?: string | null;
  revokedAt?: string | null;
};

export function SettingsPanel() {
  const { getToken } = useAuth();
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [secret, setSecret] = useState<string | null>(null);

  async function load() {
    const result = await apiFetch<{ keys: ApiKey[] }>("/api/api-keys", {}, getToken);
    setKeys(result.keys);
  }

  useEffect(() => {
    load().catch(() => undefined);
  }, []);

  async function createKey() {
    const result = await apiFetch<{ key: ApiKey & { secret: string } }>(
      "/api/api-keys",
      {
        method: "POST",
        body: JSON.stringify({ name: `Production key ${keys.length + 1}` })
      },
      getToken
    );
    setSecret(result.key.secret);
    await load();
  }

  async function revokeKey(id: string) {
    await apiFetch(`/api/api-keys/${id}/revoke`, { method: "POST", body: "{}" }, getToken);
    await load();
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-12 sm:px-6 lg:px-8">
      <p className="text-xs font-bold uppercase tracking-[0.28em] text-neon-cyan">Account</p>
      <h1 className="mt-2 text-4xl font-black text-white">Settings</h1>
      <section className="glass mt-8 rounded-2xl p-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <KeyRound className="text-neon-cyan" size={19} />
            <h2 className="text-lg font-black text-white">API Keys</h2>
          </div>
          <button onClick={createKey} className="focus-ring inline-flex items-center gap-2 rounded-lg bg-neon-cyan px-4 py-2 text-xs font-black text-ink">
            <Plus size={15} />
            Create
          </button>
        </div>
        {secret ? (
          <div className="mt-5 rounded-xl border border-neon-cyan/30 bg-neon-cyan/10 p-4">
            <div className="text-xs font-bold uppercase tracking-[0.2em] text-neon-cyan">New secret</div>
            <code className="mt-2 block break-all text-sm text-white">{secret}</code>
          </div>
        ) : null}
        <div className="mt-5 divide-y divide-line overflow-hidden rounded-xl border border-line">
          {keys.map((key) => (
            <div key={key.id} className="flex items-center justify-between bg-white/[0.03] p-4">
              <div>
                <div className="font-bold text-white">{key.name}</div>
                <div className="mt-1 text-xs text-slate-500">{key.prefix} · {key.revokedAt ? "revoked" : "active"}</div>
              </div>
              {!key.revokedAt ? (
                <button onClick={() => revokeKey(key.id)} className="focus-ring rounded-lg border border-line px-3 py-2 text-slate-400 hover:border-neon-rose hover:text-neon-rose">
                  <Trash2 size={15} />
                </button>
              ) : null}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
