import {
  ArrowUp,
  ArrowUpRight,
  Check,
  ChevronDown,
  Hash,
  Loader2,
  User,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  TalkMessage_Serialize,
  TalkRoom_Serialize,
} from "../../bindings/tauri";
import { formatIsoDate, formatTime24h } from "../../lib/dateFormat";
import { NAV_MOD_KEY, QUICK_CHAT_SHORTCUT } from "../../lib/platform";
import {
  draftSyncListeners,
  getActiveQuickChatAccount,
  getOrCreateQuickChatDraft,
  makeQuickChatScopeKey,
  notifyQuickChatListeners,
  scopedDrafts,
  scopedSendingKeys,
  scopedSentMessages,
  syncQuickChatAccount,
} from "../../lib/quickChatStore";
import { hasActiveOverlay, isEditableTarget } from "../../lib/shortcuts";
import {
  getTalkDraft,
  getTalkMessages,
  listTalkRooms,
  saveTalkDraft,
  sendTalkMessage,
} from "../../lib/talkClient";
import { IconButton } from "../ui/Tooltip";

interface QuickChatDrawerProps {
  accountKey: string | null;
  isNextcloudConnected: boolean;
  onClose: () => void;
  onOpenFullChat: () => void;
}

function messageDedupKey(msg: TalkMessage_Serialize): string {
  if (msg.id !== null && msg.id !== undefined) {
    return `id:${msg.id}`;
  }
  return `ref:${msg.referenceId || `${msg.timestamp ?? 0}:${msg.actorId}:${msg.message}`}`;
}

function mergeQuickChatMessages(
  existing: TalkMessage_Serialize[],
  incoming: TalkMessage_Serialize[],
): TalkMessage_Serialize[] {
  const map = new Map<string, TalkMessage_Serialize>();
  for (const m of existing) {
    map.set(messageDedupKey(m), m);
  }
  for (const m of incoming) {
    map.set(messageDedupKey(m), m);
  }
  return Array.from(map.values()).sort((a, b) => {
    const ta = a.timestamp ?? 0;
    const tb = b.timestamp ?? 0;
    if (ta !== tb) return ta - tb;
    return (a.id ?? 0) - (b.id ?? 0);
  });
}

function formatTime(ts: number | null): string {
  return formatTime24h(ts);
}

export function QuickChatDrawer({
  accountKey,
  isNextcloudConnected,
  onClose,
  onOpenFullChat,
}: QuickChatDrawerProps) {
  syncQuickChatAccount(isNextcloudConnected ? accountKey : null);

  const effectiveAccountKey = isNextcloudConnected ? accountKey : null;
  const [rooms, setRooms] = useState<TalkRoom_Serialize[]>([]);
  const [roomsError, setRoomsError] = useState<string | null>(null);
  const [selectedToken, setSelectedToken] = useState<string | null>(null);
  const [roomMenuOpen, setRoomMenuOpen] = useState(false);
  const [messages, setMessages] = useState<TalkMessage_Serialize[]>([]);
  const [messagesRoomToken, setMessagesRoomToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [messagesError, setMessagesError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [, setSyncTick] = useState(0);
  const [sendError, setSendError] = useState<string | null>(null);
  const drawerRef = useRef<HTMLDivElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const accountKeyRef = useRef<string | null>(effectiveAccountKey);
  accountKeyRef.current = effectiveAccountKey;
  const selectedTokenRef = useRef<string | null>(null);
  selectedTokenRef.current = selectedToken;
  const messagesRoomTokenRef = useRef<string | null>(null);
  messagesRoomTokenRef.current = messagesRoomToken;
  const roomsReqSeqRef = useRef(0);
  const messagesReqSeqRef = useRef(0);

  const flushDraftForRoom = useCallback((acct: string, token: string) => {
    const key = makeQuickChatScopeKey(acct, token);
    const entry = scopedDrafts.get(key);
    if (!entry) return;
    if (entry.timer !== null) {
      window.clearTimeout(entry.timer);
      entry.timer = null;
    }
    if (!entry.dirty || getActiveQuickChatAccount() !== acct) return;
    entry.dirty = false;
    const textToSave = entry.text;
    void saveTalkDraft(token, textToSave).catch(() => {});
  }, []);

  const scheduleDraftSave = useCallback(
    (acct: string, token: string, value: string) => {
      if (getActiveQuickChatAccount() !== acct) return;
      const entry = getOrCreateQuickChatDraft(acct, token);
      entry.revision += 1;
      entry.text = value;
      entry.hydrated = true;
      entry.dirty = true;
      const scheduledRev = entry.revision;
      if (entry.timer !== null) {
        window.clearTimeout(entry.timer);
      }
      entry.timer = window.setTimeout(() => {
        entry.timer = null;
        if (
          getActiveQuickChatAccount() !== acct ||
          entry.revision !== scheduledRev
        ) {
          return;
        }
        entry.dirty = false;
        void saveTalkDraft(token, entry.text).catch(() => {});
      }, 300);
    },
    [],
  );

  // Sync draft/sending state if an in-flight send finishes for the active room
  useEffect(() => {
    const sync = () => {
      const acct = accountKeyRef.current;
      const tok = selectedTokenRef.current;
      if (acct && tok) {
        const key = makeQuickChatScopeKey(acct, tok);
        const entry = scopedDrafts.get(key);
        if (entry) {
          setDraft(entry.text);
        }
        const sent = scopedSentMessages.get(key);
        if (sent && sent.length > 0 && messagesRoomTokenRef.current === tok) {
          setMessages((prev) => mergeQuickChatMessages(prev, sent));
        }
      }
      setSyncTick((n) => n + 1);
    };
    draftSyncListeners.add(sync);
    return () => {
      draftSyncListeners.delete(sync);
    };
  }, []);

  const selectRoom = useCallback(
    (nextToken: string) => {
      const acct = accountKeyRef.current;
      const prevToken = selectedTokenRef.current;
      if (acct && prevToken && prevToken !== nextToken) {
        flushDraftForRoom(acct, prevToken);
      }
      setSendError(null);
      setMessagesError(null);
      if (prevToken !== nextToken) {
        setMessages([]);
        setMessagesRoomToken(null);
        const existingText = acct
          ? (scopedDrafts.get(makeQuickChatScopeKey(acct, nextToken))?.text ?? "")
          : "";
        setDraft(existingText);
        if (textareaRef.current) {
          textareaRef.current.style.height = "auto";
        }
      }
      setSelectedToken(nextToken);
    },
    [flushDraftForRoom],
  );

  // Reset visible drawer state when signed out or account changes
  useEffect(() => {
    if (!effectiveAccountKey) {
      setRooms([]);
      setRoomsError(null);
      setSelectedToken(null);
      setMessages([]);
      setMessagesRoomToken(null);
      setMessagesError(null);
      setDraft("");
      setSendError(null);
      setLoading(false);
      setLoadingMessages(false);
    }
  }, [effectiveAccountKey]);

  // Flush dirty drafts for the active account on unmount
  useEffect(() => {
    return () => {
      const acct = accountKeyRef.current;
      if (!acct || getActiveQuickChatAccount() !== acct) return;
      for (const entry of scopedDrafts.values()) {
        if (entry.accountKey === acct) {
          flushDraftForRoom(acct, entry.roomToken);
        }
      }
    };
  }, [flushDraftForRoom]);

  useEffect(() => {
    const drawerEl = drawerRef.current;
    const focusTimer = window.setTimeout(() => {
      textareaRef.current?.focus();
    }, 30);
    return () => {
      window.clearTimeout(focusTimer);
      if (
        document.activeElement &&
        drawerEl?.contains(document.activeElement)
      ) {
        document
          .querySelector<HTMLButtonElement>(
            'button[aria-label="Toggle quick chat drawer"]',
          )
          ?.focus();
      }
    };
  }, []);

  useEffect(() => {
    if (roomMenuOpen) return;
    const onEscape = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (
        hasActiveOverlay() ||
        document.querySelector('[role="tooltip"]') !== null
      ) {
        return;
      }
      // Do not steal Escape from an inline rename/editor field outside the drawer
      if (
        isEditableTarget(e.target) &&
        !(e.target instanceof Node && drawerRef.current?.contains(e.target))
      ) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onEscape, true);
    return () => window.removeEventListener("keydown", onEscape, true);
  }, [roomMenuOpen, onClose]);

  useEffect(() => {
    if (!roomMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setRoomMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setRoomMenuOpen(false);
        menuRef.current?.querySelector("button")?.focus();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const items = Array.from(
          menuRef.current?.querySelectorAll<HTMLButtonElement>(
            '[role="menuitem"]',
          ) ?? [],
        );
        if (items.length === 0) return;
        e.preventDefault();
        const curIdx = items.indexOf(
          document.activeElement as HTMLButtonElement,
        );
        const nextIdx =
          e.key === "ArrowDown"
            ? (curIdx + 1) % items.length
            : curIdx <= 0
              ? items.length - 1
              : curIdx - 1;
        items[nextIdx]?.focus();
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [roomMenuOpen]);

  const loadRooms = useCallback(
    (acct: string) => {
      let cancelled = false;
      const seq = ++roomsReqSeqRef.current;
      setLoading(true);
      setRoomsError(null);
      void listTalkRooms(null)
        .then((page) => {
          if (
            cancelled ||
            accountKeyRef.current !== acct ||
            roomsReqSeqRef.current !== seq
          ) {
            return;
          }
          setRooms(page.rooms);
          if (page.rooms.length > 0 && !selectedTokenRef.current) {
            selectRoom(page.rooms[0].token);
          }
        })
        .catch(() => {
          if (
            cancelled ||
            accountKeyRef.current !== acct ||
            roomsReqSeqRef.current !== seq
          ) {
            return;
          }
          setRooms([]);
          setSelectedToken(null);
          setRoomsError("Could not load chat rooms.");
        })
        .finally(() => {
          if (
            !cancelled &&
            accountKeyRef.current === acct &&
            roomsReqSeqRef.current === seq
          ) {
            setLoading(false);
          }
        });
      return () => {
        cancelled = true;
      };
    },
    [selectRoom],
  );

  useEffect(() => {
    if (!effectiveAccountKey) return;
    return loadRooms(effectiveAccountKey);
  }, [effectiveAccountKey, loadRooms]);

  const loadRoomMessages = useCallback((acct: string, token: string) => {
    let cancelled = false;
    const seq = ++messagesReqSeqRef.current;
    setLoadingMessages(true);
    setMessagesError(null);
    setMessages([]);
    setMessagesRoomToken(null);
    void getTalkMessages(token, null, 25)
      .then((page) => {
        if (
          cancelled ||
          accountKeyRef.current !== acct ||
          selectedTokenRef.current !== token ||
          messagesReqSeqRef.current !== seq
        ) {
          return;
        }
        const pendingSent =
          scopedSentMessages.get(makeQuickChatScopeKey(acct, token)) ?? [];
        const merged = mergeQuickChatMessages(page.messages, pendingSent);
        setMessages(merged);
        setMessagesRoomToken(token);
        window.setTimeout(
          () => endRef.current?.scrollIntoView({ behavior: "auto" }),
          20,
        );
      })
      .catch(() => {
        if (
          cancelled ||
          accountKeyRef.current !== acct ||
          selectedTokenRef.current !== token ||
          messagesReqSeqRef.current !== seq
        ) {
          return;
        }
        setMessages([]);
        setMessagesRoomToken(null);
        setMessagesError("Could not load messages for this room.");
      })
      .finally(() => {
        if (
          !cancelled &&
          accountKeyRef.current === acct &&
          selectedTokenRef.current === token &&
          messagesReqSeqRef.current === seq
        ) {
          setLoadingMessages(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!effectiveAccountKey || !selectedToken) return;
    const acct = effectiveAccountKey;
    const token = selectedToken;
    const cancelMessages = loadRoomMessages(acct, token);

    let draftCancelled = false;
    const scopeKey = makeQuickChatScopeKey(acct, token);
    const entry = getOrCreateQuickChatDraft(acct, token);
    const readRevision = entry.revision;
    if (entry.hydrated) {
      setDraft(entry.text);
    }
    if (!entry.dirty && !scopedSendingKeys.has(scopeKey)) {
      void getTalkDraft(token)
        .then((saved) => {
          if (
            draftCancelled ||
            getActiveQuickChatAccount() !== acct ||
            entry.revision !== readRevision ||
            entry.dirty ||
            scopedSendingKeys.has(scopeKey)
          ) {
            return;
          }
          const resolved = saved ?? "";
          entry.text = resolved;
          entry.hydrated = true;
          if (
            accountKeyRef.current === acct &&
            selectedTokenRef.current === token
          ) {
            setDraft(resolved);
          }
        })
        .catch(() => {});
    }

    return () => {
      draftCancelled = true;
      cancelMessages();
    };
  }, [effectiveAccountKey, selectedToken, loadRoomMessages]);

  async function submitDraft() {
    const targetAccount = accountKeyRef.current;
    const targetToken = selectedTokenRef.current;
    if (!targetAccount || !targetToken) return;
    const scopeKey = makeQuickChatScopeKey(targetAccount, targetToken);
    if (scopedSendingKeys.has(scopeKey)) return;

    const entry = getOrCreateQuickChatDraft(targetAccount, targetToken);
    const submittedText = draft;
    const trimmed = submittedText.trim();
    if (!trimmed) return;

    // Ensure the shared draft store reflects the exact submitted text and revision
    if (entry.text !== submittedText) {
      entry.revision += 1;
      entry.text = submittedText;
      entry.hydrated = true;
    }
    const sendRevision = entry.revision;
    if (entry.timer !== null) {
      window.clearTimeout(entry.timer);
      entry.timer = null;
    }
    entry.dirty = false;

    scopedSendingKeys.add(scopeKey);
    notifyQuickChatListeners();
    setSendError(null);

    try {
      const sent = await sendTalkMessage({
        token: targetToken,
        message: trimmed,
        replyTo: null,
        referenceId: null,
      });

      // Ignore completion if user signed out or switched accounts while request was in flight
      if (getActiveQuickChatAccount() !== targetAccount) {
        return;
      }

      const prevSent = scopedSentMessages.get(scopeKey) ?? [];
      scopedSentMessages.set(
        scopeKey,
        mergeQuickChatMessages(prevSent, [sent]),
      );

      const currentEntry = getOrCreateQuickChatDraft(targetAccount, targetToken);
      if (currentEntry.revision === sendRevision) {
        currentEntry.revision += 1;
        currentEntry.text = "";
        currentEntry.hydrated = true;
        currentEntry.dirty = false;
        if (currentEntry.timer !== null) {
          window.clearTimeout(currentEntry.timer);
          currentEntry.timer = null;
        }
        void saveTalkDraft(targetToken, "").catch(() => {});
      } else if (currentEntry.text.startsWith(submittedText)) {
        const remaining = currentEntry.text
          .slice(submittedText.length)
          .trimStart();
        currentEntry.revision += 1;
        currentEntry.text = remaining;
        currentEntry.hydrated = true;
        currentEntry.dirty = false;
        if (currentEntry.timer !== null) {
          window.clearTimeout(currentEntry.timer);
          currentEntry.timer = null;
        }
        void saveTalkDraft(targetToken, remaining).catch(() => {});
      }
      // Otherwise a newer draft revision replaced the text (e.g. in a reopened drawer):
      // leave it untouched so newer edits are never erased.

      if (
        accountKeyRef.current === targetAccount &&
        selectedTokenRef.current === targetToken &&
        textareaRef.current &&
        !currentEntry.text
      ) {
        textareaRef.current.style.height = "auto";
      }
      notifyQuickChatListeners();
    } catch {
      if (getActiveQuickChatAccount() === targetAccount) {
        const currentEntry = getOrCreateQuickChatDraft(targetAccount, targetToken);
        if (currentEntry.revision === sendRevision) {
          void saveTalkDraft(targetToken, currentEntry.text).catch(() => {});
        }
        if (
          accountKeyRef.current === targetAccount &&
          selectedTokenRef.current === targetToken
        ) {
          setSendError("Could not send message. Your draft was kept.");
        }
      }
    } finally {
      scopedSendingKeys.delete(scopeKey);
      notifyQuickChatListeners();
    }
  }

  function handleSend(e: React.FormEvent) {
    e.preventDefault();
    void submitDraft();
  }

  const activeRoom = rooms.find((r) => r.token === selectedToken) ?? null;
  const sending = Boolean(
    effectiveAccountKey &&
      selectedToken &&
      scopedSendingKeys.has(
        makeQuickChatScopeKey(effectiveAccountKey, selectedToken),
      ),
  );
  const visibleMessages =
    effectiveAccountKey && selectedToken && messagesRoomToken === selectedToken
      ? messages.filter((m) => m.messageType !== "system")
      : [];

  return (
    <div ref={drawerRef} className="flex h-full flex-col bg-[var(--bg-sidebar)]">
      {/* Header (aligned h-10 inspector bar with custom flat room menu) */}
      <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-[var(--border-hairline)] px-3">
        <div ref={menuRef} className="relative min-w-0 flex-1">
          <button
            type="button"
            disabled={rooms.length === 0}
            onClick={() => setRoomMenuOpen((v) => !v)}
            aria-label="Select chat room"
            aria-haspopup="menu"
            aria-expanded={roomMenuOpen}
            className="flex max-w-full items-center gap-1.5 rounded px-1.5 py-1 text-xs font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)] disabled:opacity-50"
          >
            {activeRoom?.roomType === "oneToOne" ? (
              <User
                className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]"
                strokeWidth={1.5}
              />
            ) : (
              <Hash
                className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]"
                strokeWidth={1.5}
              />
            )}
            <span className="truncate">
              {activeRoom?.displayName ?? "Quick Chat"}
            </span>
            <ChevronDown
              className="h-3 w-3 shrink-0 text-[var(--text-muted)]"
              strokeWidth={1.5}
            />
          </button>

          {roomMenuOpen && rooms.length > 0 && (
            <div
              role="menu"
              aria-label="Chat rooms"
              className="absolute top-full left-0 z-30 mt-1 w-56 overflow-hidden rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] p-1"
            >
              {rooms.map((r) => {
                const selected = r.token === selectedToken;
                return (
                  <button
                    key={r.token}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      selectRoom(r.token);
                      setRoomMenuOpen(false);
                    }}
                    className={`flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors ${
                      selected
                        ? "bg-[var(--bg-active)] font-medium text-[var(--text-primary)]"
                        : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                    }`}
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      {r.roomType === "oneToOne" ? (
                        <User
                          className="h-3 w-3 shrink-0 text-[var(--text-muted)]"
                          strokeWidth={1.5}
                        />
                      ) : (
                        <Hash
                          className="h-3 w-3 shrink-0 text-[var(--text-muted)]"
                          strokeWidth={1.5}
                        />
                      )}
                      <span className="truncate">{r.displayName}</span>
                    </span>
                    {selected && (
                      <Check
                        className="h-3 w-3 shrink-0 text-[var(--accent-text)]"
                        strokeWidth={1.5}
                      />
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          <IconButton
            label="Open full Chat"
            shortcut={`${NAV_MOD_KEY}4`}
            size="xs"
            onClick={onOpenFullChat}
          >
            <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={1.5} />
          </IconButton>
          <IconButton
            label="Close quick chat"
            shortcut={QUICK_CHAT_SHORTCUT}
            size="xs"
            onClick={onClose}
          >
            <X className="h-3.5 w-3.5" strokeWidth={1.5} />
          </IconButton>
        </div>
      </div>

      {/* Stream (exact TalkView typography & subtle hairline dividers) */}
      <div
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
        aria-label="Quick chat messages"
        className="min-h-0 flex-1 overflow-y-auto py-1"
      >
        {!effectiveAccountKey ? (
          <p className="px-4 py-10 text-center text-xs text-[var(--text-muted)]">
            Connect Nextcloud to access team chat.
          </p>
        ) : loading || loadingMessages ? (
          <div className="flex items-center justify-center gap-2 py-10 text-xs text-[var(--text-muted)]">
            <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.5} />
            {loading ? "Loading rooms…" : "Loading messages…"}
          </div>
        ) : roomsError ? (
          <div
            role="alert"
            className="flex flex-col items-center gap-2 px-4 py-10 text-center text-xs text-[var(--status-danger-text)]"
          >
            <p>{roomsError}</p>
            <button
              type="button"
              onClick={() => void loadRooms(effectiveAccountKey)}
              className="rounded border border-[var(--border-strong)] bg-[var(--bg-surface)] px-2.5 py-1 text-[11px] font-medium text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
            >
              Retry
            </button>
          </div>
        ) : messagesError ? (
          <div
            role="alert"
            className="flex flex-col items-center gap-2 px-4 py-10 text-center text-xs text-[var(--status-danger-text)]"
          >
            <p>{messagesError}</p>
            {selectedToken && (
              <button
                type="button"
                onClick={() =>
                  void loadRoomMessages(effectiveAccountKey, selectedToken)
                }
                className="rounded border border-[var(--border-strong)] bg-[var(--bg-surface)] px-2.5 py-1 text-[11px] font-medium text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
              >
                Retry
              </button>
            )}
          </div>
        ) : rooms.length === 0 ? (
          <p className="px-4 py-10 text-center text-xs text-[var(--text-muted)]">
            No chat rooms available.
          </p>
        ) : visibleMessages.length === 0 ? (
          <p className="px-4 py-10 text-center text-xs text-[var(--text-muted)]">
            No recent messages in this room.
          </p>
        ) : (
          <div className="divide-y divide-[var(--border-subtle)]/60">
            {visibleMessages.map((msg, idx, arr) => {
              const prev = idx > 0 ? arr[idx - 1] : null;
              const msgDay = msg.timestamp
                ? formatIsoDate(new Date(msg.timestamp * 1000))
                : null;
              const prevDay = prev?.timestamp
                ? formatIsoDate(new Date(prev.timestamp * 1000))
                : null;
              const showDate = Boolean(msgDay && msgDay !== prevDay);
              return (
                <div key={messageDedupKey(msg)}>
                  {showDate && msgDay && (
                    <div className="flex items-center gap-2 px-3.5 py-1">
                      <span
                        aria-hidden="true"
                        className="h-px flex-1 bg-[var(--border-hairline)]"
                      />
                      <span className="mono-num text-[11px] font-medium text-[var(--text-muted)]">
                        {msgDay}
                      </span>
                      <span
                        aria-hidden="true"
                        className="h-px flex-1 bg-[var(--border-hairline)]"
                      />
                    </div>
                  )}
                  <div className="px-3.5 py-2.5 transition-colors hover:bg-[var(--bg-hover)]/70">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-xs font-medium text-[var(--text-primary)]">
                        {msg.actorDisplayName}
                      </span>
                      <span className="mono-num shrink-0 text-[11px] text-[var(--text-muted)]">
                        {formatTime(msg.timestamp)}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[13px] leading-relaxed whitespace-pre-wrap break-words text-[var(--text-primary)]">
                      {msg.deleted ? "Message deleted" : msg.message}
                    </p>
                  </div>
                </div>
              );
            })}
            <div ref={endRef} />
          </div>
        )}
      </div>

      {/* Anchored Multiline Composer */}
      {effectiveAccountKey && activeRoom && !activeRoom.readOnly && (
        <form
          onSubmit={handleSend}
          className="border-t border-[var(--border-hairline)] p-2.5"
        >
          {sendError && (
            <p
              role="alert"
              className="mb-1.5 text-[11px] text-[var(--status-danger-text)]"
            >
              {sendError}
            </p>
          )}
          <div className="flex items-end gap-1.5 rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-2 py-1.5 focus-within:border-[var(--accent)]">
            <textarea
              ref={textareaRef}
              rows={1}
              aria-label={`Message ${activeRoom.displayName}`}
              value={draft}
              onChange={(e) => {
                const nextValue = e.target.value;
                setDraft(nextValue);
                if (accountKeyRef.current && selectedTokenRef.current) {
                  scheduleDraftSave(
                    accountKeyRef.current,
                    selectedTokenRef.current,
                    nextValue,
                  );
                }
                e.target.style.height = "auto";
                e.target.style.height = `${Math.min(e.target.scrollHeight, 112)}px`;
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void submitDraft();
                }
              }}
              placeholder={`Message ${activeRoom.displayName}…`}
              className="max-h-28 min-w-0 flex-1 resize-none bg-transparent text-[13px] leading-snug text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
            />
            <IconButton
              type="submit"
              label="Send message"
              shortcut="Enter"
              size="xs"
              tone={draft.trim() ? "accent" : "default"}
              disabled={sending || !draft.trim()}
            >
              {sending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.5} />
              ) : (
                <ArrowUp className="h-3.5 w-3.5" strokeWidth={1.5} />
              )}
            </IconButton>
          </div>
        </form>
      )}
      <div className="mono-num flex h-8 shrink-0 items-center justify-between border-t border-[var(--border-hairline)] bg-[var(--bg-app)] px-3 text-[11px] text-[var(--text-muted)]">
        <span>{rooms.length} rooms</span>
        <span>
          {rooms.reduce((sum, r) => sum + (r.unreadMessages ?? 0), 0)} unread
        </span>
      </div>
    </div>
  );
}
