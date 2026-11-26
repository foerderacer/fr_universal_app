import { isTauri } from "@tauri-apps/api/core";
import {
  commands,
  type FinanceCurrencySummary,
  type FinanceEntry_Serialize,
  type UpsertFinanceEntryRequest_Deserialize,
  type WorkspaceOverview_Serialize,
} from "../bindings/tauri";

function requireDesktop(action: string): never {
  throw {
    code: "browser_preview",
    title: "Desktop app required",
    message: `${action} is available inside the FR Universal App desktop window.`,
    recoveryHint: "Launch FR Universal App via Tauri.",
    technicalDetails: null,
  };
}

export async function listFinanceEntries(): Promise<FinanceEntry_Serialize[]> {
  if (!isTauri()) return [];
  return commands.listFinanceEntries();
}

export async function upsertFinanceEntry(
  input: UpsertFinanceEntryRequest_Deserialize,
): Promise<FinanceEntry_Serialize> {
  if (!isTauri()) requireDesktop("Saving Finance entries");
  return commands.upsertFinanceEntry(input);
}

export async function deleteFinanceEntry(entryId: string): Promise<void> {
  if (!isTauri()) requireDesktop("Deleting Finance entries");
  await commands.deleteFinanceEntry(entryId);
}

export async function getFinanceSummary(): Promise<FinanceCurrencySummary[]> {
  if (!isTauri()) return [];
  return commands.getFinanceSummary();
}

export async function exportFinanceCsv(): Promise<string> {
  if (!isTauri()) requireDesktop("Exporting Finance CSV");
  return commands.exportFinanceCsv();
}

export async function setFinanceFolder(
  folderPath: string,
): Promise<WorkspaceOverview_Serialize> {
  if (!isTauri()) requireDesktop("Saving Finance folder");
  return commands.setFinanceFolder(folderPath);
}

/** Formats minor units (cents) cleanly for UI display. */
export function formatCurrencyCents(
  cents: number | null | undefined,
  currency: string,
): string {
  const safe = typeof cents === "number" && Number.isFinite(cents) ? cents : 0;
  const amount = safe / 100;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency.toUpperCase(),
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency.toUpperCase()}`;
  }
}

/** Parses a human decimal string (e.g. "123.45" or "123,45") into exact integer cents. */
export function parseAmountToCents(raw: string): number | null {
  const normalized = raw.trim().replace(/\s+/g, "").replace(",", ".");
  if (!/^-?\d+(\.\d{1,2})?$/.test(normalized)) {
    return null;
  }
  const negative = normalized.startsWith("-");
  const unsigned = negative ? normalized.slice(1) : normalized;
  const [wholePart, fracPart = ""] = unsigned.split(".");
  const whole = Number.parseInt(wholePart, 10);
  const frac = Number.parseInt(fracPart.padEnd(2, "0"), 10);
  if (!Number.isSafeInteger(whole) || !Number.isSafeInteger(frac)) {
    return null;
  }
  const cents = whole * 100 + frac;
  if (!Number.isSafeInteger(cents)) {
    return null;
  }
  return negative ? -cents : cents;
}
