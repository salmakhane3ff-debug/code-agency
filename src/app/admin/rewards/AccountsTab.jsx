"use client";

import { useState, useEffect, useCallback } from "react";
import { Loader2, Search, AlertTriangle } from "lucide-react";
import { REDEMPTION_STATUS_UI, LEDGER_TYPE_LABEL, Badge, Modal, ErrorNote, api, fmtDate, fmtPoints, newRequestId, inputCls, btnPrimary, btnGhost } from "./ui";

const AWARD_STATE_LABEL = { AWARDED: "Points attribués", REVERSED: "Points annulés", EXCLUDED: "Exclue (avant lancement / pause)" };

export default function AccountsTab() {
  const [q, setQ]           = useState("");
  const [query, setQuery]   = useState("");
  const [rows, setRows]     = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState(null);
  const [openId, setOpenId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    const r = await api(`/api/admin/rewards/accounts?q=${encodeURIComponent(query)}`);
    setRows(r.ok && Array.isArray(r.data) ? r.data : []);
    setError(r.ok ? null : r.error);
    setLoading(false);
  }, [query]);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-4">
      <form onSubmit={(e) => { e.preventDefault(); setQuery(q); }} className="bg-white rounded-2xl border border-gray-100 p-4 relative">
        <Search className="absolute right-7 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rechercher un affilié (nom ou username)…" className={`${inputCls} pr-9`} />
      </form>
      <ErrorNote message={error} />
      {loading ? (
        <div className="flex justify-center py-16"><Loader2 className="w-7 h-7 animate-spin text-gray-400" /></div>
      ) : rows.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-100 py-14 text-center text-gray-400 text-sm">Aucun affilié</div>
      ) : (
        <div className="bg-white rounded-2xl border border-gray-100 divide-y divide-gray-50">
          {rows.map((a) => (
            <button key={a.id} onClick={() => setOpenId(a.id)} className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-gray-50">
              <div className="min-w-0">
                <p className="font-semibold text-gray-900 truncate">{a.name || a.username}</p>
                <p className="text-xs text-gray-500">@{a.username}{!a.isActive && " · inactif"}</p>
              </div>
              <span className={`text-sm font-bold ${a.balance < 0 ? "text-red-600" : "text-violet-700"}`}>{fmtPoints(a.balance)}</span>
            </button>
          ))}
        </div>
      )}
      {openId && <AccountDetail affiliateId={openId} onClose={() => setOpenId(null)} onChanged={load} />}
    </div>
  );
}

function AccountDetail({ affiliateId, onClose, onChanged }) {
  const [data, setData]   = useState(null);
  const [error, setError] = useState(null);
  const [delta, setDelta] = useState("");
  const [reason, setReason] = useState("");
  const [requestId, setRequestId] = useState(newRequestId);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy]   = useState(false);
  const [ledger, setLedger] = useState([]);
  const [cursor, setCursor] = useState(null);

  const load = useCallback(async () => {
    const r = await api(`/api/admin/rewards/accounts/${affiliateId}`);
    if (r.ok) { setData(r.data); setLedger(r.data.ledger.items); setCursor(r.data.ledger.nextCursor); } else setError(r.error);
  }, [affiliateId]);
  useEffect(() => { load(); }, [load]);

  const moreLedger = async () => {
    const r = await api(`/api/admin/rewards/accounts/${affiliateId}?cursor=${cursor}`);
    if (r.ok) { setLedger((l) => [...l, ...r.data.ledger.items]); setCursor(r.data.ledger.nextCursor); }
  };

  const n = Number(delta);
  const valid = Number.isInteger(n) && n !== 0 && reason.trim().length >= 5;
  const submit = async () => {
    setBusy(true); setError(null);
    const r = await api(`/api/admin/rewards/accounts/${affiliateId}/adjust`, { method: "POST", body: { delta: n, reason, clientRequestId: requestId } });
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    setConfirming(false); setDelta(""); setReason(""); setRequestId(newRequestId());
    await load(); onChanged();
  };

  if (!data) {
    return <Modal title="Compte de points" onClose={onClose}>{error ? <ErrorNote message={error} /> : <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-gray-400" /></div>}</Modal>;
  }
  const s = data.summary;
  return (
    <Modal title={`Points — ${data.affiliate.name || data.affiliate.username} (@${data.affiliate.username})`} onClose={busy ? () => {} : onClose} wide>
      <div className="space-y-5">
        <ErrorNote message={error} />
        {!data.booksBalanced && (
          <p className="text-sm text-red-700 bg-red-50 border border-red-100 rounded-xl px-3 py-2 flex gap-2"><AlertTriangle className="w-4 h-4 shrink-0" /> Écart entre le solde et le journal — à signaler.</p>
        )}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {[["Solde", s.balance], ["Utilisable", s.spendable], ["Total gagné", s.totalEarned], ["Total utilisé", s.totalRedeemed]].map(([label, v]) => (
            <div key={label} className="bg-gray-50 rounded-xl p-3">
              <p className="text-[11px] text-gray-500">{label}</p>
              <p className={`text-lg font-black ${v < 0 ? "text-red-600" : "text-gray-900"}`}>{fmtPoints(v)}</p>
            </div>
          ))}
        </div>
        {(s.held > 0 || s.debt > 0) && (
          <p className="text-xs text-gray-500">{s.held > 0 && <>{fmtPoints(s.held)} en période de rétention. </>}{s.debt > 0 && <span className="text-red-600">Dette de {fmtPoints(s.debt)} (commande annulée après utilisation).</span>}</p>
        )}

        <div className="border border-gray-200 rounded-2xl p-4 space-y-2">
          <p className="text-sm font-bold text-gray-900">Ajustement manuel</p>
          <div className="grid sm:grid-cols-3 gap-2">
            <input type="number" step={1} value={delta} onChange={(e) => { setDelta(e.target.value); setConfirming(false); }} placeholder="+50 ou -20" className={inputCls} />
            <input value={reason} onChange={(e) => { setReason(e.target.value); setConfirming(false); }} placeholder="Motif (obligatoire)" className={`${inputCls} sm:col-span-2`} />
          </div>
          {!confirming ? (
            <div className="flex justify-end"><button disabled={!valid} onClick={() => setConfirming(true)} className={btnPrimary}>Continuer</button></div>
          ) : (
            <div className="flex flex-wrap items-center justify-end gap-2">
              <span className="text-xs text-gray-600">{n > 0 ? "Créditer" : "Débiter"} <b>{fmtPoints(Math.abs(n))}</b> — solde après : <b>{fmtPoints(s.balance + n)}</b></span>
              <button onClick={() => setConfirming(false)} disabled={busy} className={btnGhost}>Retour</button>
              <button onClick={submit} disabled={busy} className={btnPrimary}>{busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Confirmer</button>
            </div>
          )}
        </div>

        <div>
          <p className="text-xs font-semibold text-gray-500 mb-2">Journal des points</p>
          {ledger.length === 0 ? <p className="text-sm text-gray-400">Aucun mouvement</p> : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead><tr className="text-left text-gray-400"><th className="py-1 pr-3">Date</th><th className="pr-3">Type</th><th className="pr-3 text-right">Points</th><th className="pr-3 text-right">Solde</th><th>Motif</th></tr></thead>
                <tbody className="divide-y divide-gray-50">
                  {ledger.map((l) => (
                    <tr key={l.id}>
                      <td className="py-1.5 pr-3 whitespace-nowrap text-gray-500">{fmtDate(l.createdAt)}</td>
                      <td className="pr-3 whitespace-nowrap">{LEDGER_TYPE_LABEL[l.type] || l.type}</td>
                      <td className={`pr-3 text-right font-bold ${l.delta < 0 ? "text-red-600" : "text-emerald-700"}`}>{l.delta > 0 ? "+" : ""}{l.delta}</td>
                      <td className="pr-3 text-right">{l.balanceAfter}</td>
                      <td className="text-gray-500">{l.reason || "—"}{l.actorType === "ADMIN" && " (admin)"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {cursor && <button onClick={moreLedger} className={`${btnGhost} w-full mt-2`}>Plus</button>}
        </div>

        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <p className="text-xs font-semibold text-gray-500 mb-2">Commandes (points)</p>
            {data.awards.length === 0 ? <p className="text-sm text-gray-400">—</p> : data.awards.map((a) => (
              <p key={a.id} className="text-xs text-gray-600 py-0.5">
                <span className="font-mono">{a.affiliateOrderId.slice(0, 8)}</span> · {AWARD_STATE_LABEL[a.state] || a.state}{a.points ? ` · ${fmtPoints(a.points)}` : ""}
              </p>
            ))}
          </div>
          <div>
            <p className="text-xs font-semibold text-gray-500 mb-2">Demandes de cadeaux</p>
            {data.redemptions.length === 0 ? <p className="text-sm text-gray-400">—</p> : data.redemptions.map((r) => (
              <div key={r.id} className="text-xs text-gray-600 py-0.5 flex items-center gap-2 flex-wrap">
                <span className="font-mono">{r.reference}</span> <Badge ui={REDEMPTION_STATUS_UI[r.status]} /> {r.giftSnapshot?.name}
              </div>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}
