'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

/** Paste a failed hash on the landing and go straight to its analysis. */
export function HashInput() {
  const router = useRouter();
  const [v, setV] = useState('');
  const [err, setErr] = useState<string | null>(null);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const h = v.trim();
        if (!TX_HASH.test(h)) {
          setErr('That is not a 32-byte transaction hash.');
          return;
        }
        router.push(`/tx/${h.toLowerCase()}`);
      }}
      className="mt-10 max-w-[720px]"
    >
      <label htmlFor="home-hash" className="marker mb-3 block">
        Paste a failed Monad mainnet transaction
      </label>
      <div className="flex flex-col gap-3 sm:flex-row">
        <input
          id="home-hash"
          value={v}
          onChange={(e) => {
            setV(e.target.value);
            if (err) setErr(null);
          }}
          spellCheck={false}
          placeholder="0x…"
          className="min-w-0 flex-1 rounded-xl border border-line bg-white px-4 py-3.5 font-mono text-[15px] outline-none focus:border-green"
        />
        <button
          type="submit"
          className="rounded-xl bg-green px-7 py-3.5 text-[15.5px] font-semibold text-white"
        >
          Why it lost
        </button>
      </div>
      <p className={`mt-3 min-h-6 text-[14px] ${err ? 'text-moved' : 'text-dim'}`}>
        {err ?? 'No hash handy? The forensics page has three real failures to click.'}
      </p>
    </form>
  );
}
