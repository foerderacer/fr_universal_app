import type { TalkMessage_Serialize } from "../bindings/tauri";

export interface ScopedDraftEntry {
  accountKey: string;
  roomToken: string;
  revision: number;
  text: string;
  hydrated: boolean;
  dirty: boolean;
  timer: number | null;
}

let activeAccountKey: string | null = null;
export const scopedDrafts = new Map<string, ScopedDraftEntry>();
export const scopedSentMessages = new Map<string, TalkMessage_Serialize[]>();
export const scopedSendingKeys = new Set<string>();
export const draftSyncListeners = new Set<() => void>();

export function getActiveQuickChatAccount(): string | null {
  return activeAccountKey;
}

export function makeQuickChatScopeKey(
  accountKey: string,
  roomToken: string,
): string {
  return `${accountKey}\0${roomToken}`;
}

export function getOrCreateQuickChatDraft(
  accountKey: string,
  roomToken: string,
): ScopedDraftEntry {
  const key = makeQuickChatScopeKey(accountKey, roomToken);
  let entry = scopedDrafts.get(key);
  if (!entry) {
    entry = {
      accountKey,
      roomToken,
      revision: 0,
      text: "",
      hydrated: false,
      dirty: false,
      timer: null,
    };
    scopedDrafts.set(key, entry);
  }
  return entry;
}

export function notifyQuickChatListeners(): void {
  for (const listener of draftSyncListeners) {
    listener();
  }
}

/**
 * Keeps the shared Quick Chat state synchronized with the currently signed-in
 * account even when the drawer is unmounted. Cancels any pending timers from
 * previous accounts so late callbacks can never write drafts under a different account.
 */
export function syncQuickChatAccount(nextAccountKey: string | null): void {
  if (activeAccountKey === nextAccountKey) return;
  const prevAccountKey = activeAccountKey;
  activeAccountKey = nextAccountKey;
  for (const [key, entry] of scopedDrafts.entries()) {
    if (entry.accountKey !== nextAccountKey) {
      if (entry.timer !== null) {
        window.clearTimeout(entry.timer);
        entry.timer = null;
      }
      entry.dirty = false;
      if (prevAccountKey && entry.accountKey === prevAccountKey) {
        scopedDrafts.delete(key);
      }
    }
  }
  for (const key of Array.from(scopedSentMessages.keys())) {
    if (!nextAccountKey || !key.startsWith(`${nextAccountKey}\0`)) {
      scopedSentMessages.delete(key);
    }
  }
  for (const key of Array.from(scopedSendingKeys)) {
    if (!nextAccountKey || !key.startsWith(`${nextAccountKey}\0`)) {
      scopedSendingKeys.delete(key);
    }
  }
  notifyQuickChatListeners();
}
