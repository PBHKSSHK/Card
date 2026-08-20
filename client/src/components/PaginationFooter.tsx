import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { ChevronLeft, ChevronRight } from "lucide-react";

// 全 app 統一嘅底部分頁 (NetSuite 式)：
//   Items per page [50 ▾]   1-50 of 141   ←  Page 1 of 3 ▾  →
// 配合 usePagination hook 用：
//   const pg = usePagination(rows);
//   ...render pg.pageItems...
//   <PaginationFooter {...pg.footerProps} />

export const PER_PAGE_OPTIONS = [20, 50, 100, 200];

export function usePagination<T>(items: T[], defaultPerPage = 50) {
  const [rawPage, setPage] = useState(1);
  const [perPage, setPerPageState] = useState(defaultPerPage);
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const page = Math.min(rawPage, totalPages); // items 縮短時自動夾返入範圍
  const pageItems = useMemo(
    () => items.slice((page - 1) * perPage, page * perPage),
    [items, page, perPage],
  );
  const setPerPage = (n: number) => { setPerPageState(n); setPage(1); };
  return {
    page, perPage, total, totalPages, pageItems, setPage, setPerPage,
    footerProps: { page, perPage, total, totalPages, onPage: setPage, onPerPage: setPerPage },
  };
}

export function PaginationFooter({ page, perPage, total, totalPages, onPage, onPerPage }: {
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
  onPage: (p: number) => void;
  onPerPage: (n: number) => void;
}) {
  if (total === 0) return null;
  const from = (page - 1) * perPage + 1;
  const to = Math.min(page * perPage, total);
  return (
    <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2 pt-3 text-sm text-muted-foreground" data-testid="pagination-footer">
      <div className="flex items-center gap-2">
        <span>Items per page</span>
        <Select value={String(perPage)} onValueChange={(v) => onPerPage(Number(v))}>
          <SelectTrigger className="h-8 w-[76px]" data-testid="pagination-per-page"><SelectValue /></SelectTrigger>
          <SelectContent>
            {PER_PAGE_OPTIONS.map((n) => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <span data-testid="pagination-range">{from}-{to} of {total}</span>
      <div className="flex items-center gap-1.5">
        <Button variant="ghost" size="icon" className="h-8 w-8" disabled={page <= 1}
          onClick={() => onPage(page - 1)} data-testid="pagination-prev">
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Select value={String(page)} onValueChange={(v) => onPage(Number(v))}>
          <SelectTrigger className="h-8 w-auto gap-1.5 px-3" data-testid="pagination-page">
            <span>Page {page} of {totalPages}</span>
          </SelectTrigger>
          <SelectContent>
            {Array.from({ length: totalPages }, (_, i) => (
              <SelectItem key={i + 1} value={String(i + 1)}>{i + 1}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="ghost" size="icon" className="h-8 w-8" disabled={page >= totalPages}
          onClick={() => onPage(page + 1)} data-testid="pagination-next">
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
