"use client";

/**
 * src/components/checkout/BankDetailsCard.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * The "bank details" card (logo, bank name, account holder, RIB + copy, account
 * number + copy, SWIFT) shared by /checkout/confirm and the affiliate deposit
 * page. Self-contained: owns its own copy-to-clipboard state. Presentational —
 * pass a resolved `bankInfo` object + the labels; identical markup for both.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useState } from "react";
import { Building2, Copy, CheckCircle } from "lucide-react";

const DEFAULT_LABELS = {
  title:         "Coordonnées bancaires",
  bankName:      "Banque",
  accountHolder: "Titulaire du compte",
  accountNumber: "Numéro de compte",
  copy:          "Copier",
  copied:        "Copié",
};

// `dir` / `valueDir` are optional: the affiliate area passes its market direction (MA RTL / FR LTR) and
// "ltr" for the RIB / account / SWIFT values; without them (checkout) the card renders exactly as before.
export default function BankDetailsCard({ bankInfo, labels = {}, dir = "rtl", valueDir = undefined }) {
  const L = { ...DEFAULT_LABELS, ...labels };
  const [ribCopied,  setRibCopied]  = useState(false);
  const [acctCopied, setAcctCopied] = useState(false);

  const copy = (text, setFlag) => {
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      setFlag(true);
      setTimeout(() => setFlag(false), 2500);
    });
  };

  const CopyBtn = ({ copied, onClick }) => (
    <button
      onClick={onClick}
      className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded-lg font-semibold transition-all
        ${copied ? "bg-green-100 text-green-600" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>
      {copied
        ? <><CheckCircle className="w-3 h-3" /> {L.copied}</>
        : <><Copy className="w-3 h-3" /> {L.copy}</>}
    </button>
  );

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
      <div className="px-5 py-3.5 border-b border-gray-50 flex items-center gap-2">
        <div className="w-7 h-7 rounded-full bg-gray-100 flex items-center justify-center">
          <Building2 className="w-3.5 h-3.5 text-gray-700" />
        </div>
        <h2 className="font-bold text-gray-900 text-sm">{L.title}</h2>
      </div>

      <div className="p-5">
        {!bankInfo ? (
          <div className="flex justify-center py-4">
            <div className="w-5 h-5 border-2 border-gray-200 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : (
          <div className="space-y-0">
            {/* Logo row */}
            {bankInfo.logo && (
              <div className="flex items-center gap-3 pb-3 mb-1 border-b border-gray-50">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={bankInfo.logo}
                  alt={bankInfo.name || bankInfo.bankName}
                  className="h-10 w-auto max-w-[100px] object-contain rounded-lg"
                />
                <span className="text-sm font-bold text-gray-900">
                  {bankInfo.name || bankInfo.bankName}
                </span>
              </div>
            )}

            {/* Fields */}
            {[
              { label: L.bankName,      value: bankInfo.logo ? null : (bankInfo.name || bankInfo.bankName) },
              { label: L.accountHolder, value: bankInfo.accountName },
            ].map(({ label, value }) =>
              value ? (
                <div key={label} dir={dir} className="flex items-center justify-between py-3 border-b border-gray-50">
                  <span className="text-xs text-gray-400 font-medium">{label}</span>
                  <span className="text-sm font-bold text-gray-900">{value}</span>
                </div>
              ) : null
            )}

            {/* RIB with copy */}
            {bankInfo.rib && (
              <div dir={dir} className="flex items-center justify-between gap-2 py-3 border-b border-gray-50">
                <div className="flex items-center gap-1.5 shrink-0">
                  <span className="text-xs text-gray-400 font-medium">RIB</span>
                  <CopyBtn copied={ribCopied} onClick={() => copy(bankInfo.rib, setRibCopied)} />
                </div>
                <span className={`text-sm font-mono font-bold text-gray-900 flex-1 ${dir === "rtl" ? "text-left" : "text-right"} leading-relaxed`} style={{ wordBreak: "break-all" }} dir={valueDir}>
                  {bankInfo.rib}
                </span>
              </div>
            )}

            {/* Account Number with copy */}
            {bankInfo.accountNumber && (
              <div dir={dir} className="flex items-center justify-between gap-2 py-3 border-b border-gray-50">
                <div className="flex items-center gap-1.5 shrink-0">
                  <span className="text-xs text-gray-400 font-medium">{L.accountNumber}</span>
                  <CopyBtn copied={acctCopied} onClick={() => copy(bankInfo.accountNumber, setAcctCopied)} />
                </div>
                <span className={`text-sm font-mono font-bold text-gray-900 flex-1 ${dir === "rtl" ? "text-left" : "text-right"} leading-relaxed`} style={{ wordBreak: "break-all" }} dir={valueDir}>
                  {bankInfo.accountNumber}
                </span>
              </div>
            )}

            {/* SWIFT */}
            {bankInfo.swift && (
              <div dir={dir} className="flex items-center justify-between py-3">
                <span className="text-xs text-gray-400 font-medium">SWIFT / BIC</span>
                <span className="text-sm font-mono font-bold text-gray-900" dir={valueDir}>{bankInfo.swift}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
