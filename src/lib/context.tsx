import { createContext, useContext } from "react";
import type { Snapshot, Locale, Page } from "../../shared/types";
export interface POSContext {
  data: Snapshot;
  branchId: string;
  locale: Locale;
  t: (en: string, si: string) => string;
  refresh: () => Promise<void>;
  mutate: <T = unknown>(
    path: string,
    body?: unknown,
    method?: string,
  ) => Promise<T>;
  notify: (message: string, type?: "success" | "error") => void;
  navigate: (page:Page)=>void;
  back: ()=>void;
}
export const AppContext = createContext<POSContext | null>(null);
export function usePOS() {
  const value = useContext(AppContext);
  if (!value) throw new Error("Workspace context is unavailable");
  return value;
}
