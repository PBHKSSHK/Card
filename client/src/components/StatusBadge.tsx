import type { MatchStatus } from "@shared/schema";
import { Badge } from "@/components/ui/badge";

const statusConfig: Record<string, { label: string; className: string }> = {
  matched: { label: "Matched", className: "status-matched" },
  pending: { label: "Pending", className: "status-pending" },
  unmatched: { label: "Unmatched", className: "status-unmatched" },
  exception: { label: "Exception", className: "status-exception" },
  manual: { label: "Manual", className: "status-manual" },
};

export function StatusBadge({ status }: { status: MatchStatus | null | undefined }) {
  const config = statusConfig[status || 'pending'] || statusConfig.pending;
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${config.className}`}
      data-testid={`status-${status}`}
    >
      {config.label}
    </span>
  );
}

export function formatCurrency(amount: number | null | undefined, currency = 'HKD'): string {
  if (amount === null || amount === undefined) return '—';
  return new Intl.NumberFormat('en-HK', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(amount);
}
