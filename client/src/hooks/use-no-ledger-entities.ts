import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";

/**
 * Entities with NO independent NetSuite ledger (e.g. JS / Go Asia):
 * has_payable_side is false but an AR account exists — the card journal only
 * books a "Due From" (AR) line for them, so no expense account (Category) is
 * needed and the UI must not ask for one. The cardholder entity itself (PBHK)
 * has no AR code, so it's excluded and still needs a Category.
 */
export function useNoLedgerEntities(): Set<string> {
  const { data: rows = [] } = useQuery<
    { entity_code: string; has_payable_side: boolean; ar_account_code: string | null }[]
  >({
    queryKey: ["ns_intercompany_accounts_no_ledger"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("ns_intercompany_accounts")
        .select("entity_code, has_payable_side, ar_account_code");
      if (error) return [];
      return (data || []) as { entity_code: string; has_payable_side: boolean; ar_account_code: string | null }[];
    },
    retry: false,
    staleTime: 5 * 60_000,
  });
  return useMemo(() => {
    const s = new Set<string>();
    for (const a of rows) if (!a.has_payable_side && a.ar_account_code) s.add(a.entity_code);
    return s;
  }, [rows]);
}
