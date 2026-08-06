import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * NetSuite account numbers starting with '7' are Cost of Sales (i.e. project costs
 * that must be matched to a project code). This helper returns the display label for
 * an expense category dropdown — prepending "[Project]" so staff can instantly tell
 * which categories need a Project Code assigned.
 */
export function formatCategoryLabel(label: string, accountNumber: string): string {
  if (accountNumber && accountNumber.startsWith("7")) {
    return `[Project] ${label}`;
  }
  return label;
}
