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
  isNextcloudConnected: boolean;
  onClose: () => void;
  onOpenFullChat: () => void;
}

function formatTime(ts: number | null): string {
  return formatTime24h(ts);
}

export function QuickChatDrawer({
  isNextcloudConnected,
  onClose,
  onOpenFullChat,
}: QuickChatDrawerProps) {
  const [rooms, setRooms] = useState<TalkRoom_Serialize[]>([]);
  const [selectedToken, setSelectedToken] = useState<string | null>(null);
  const [roomMenuOpen, setRoomMenuOpen] = useState(false);
  const [messages, setMessages] = useState<TalkMessage_Serialize[]>([]);
  const [messagesRoomToken, setMessagesRoomToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [messagesError, setMessagesError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sendingRooms, setSendingRooms] = useState<Record<string, boolean>>({});
  const [sendError, setSendError] = useState<string | null>(null);
  const drawerRef = useRef<HTMLDivElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const selectedTokenRef = useRef<string | null>(null);
  selectedTokenRef.current = selectedToken;
  const messagesRoomTokenRef = useRef<string | null>(null);
  messagesRoomTokenRef.current = messagesRoomToken;
  const messagesReqSeqRef = useRef(0);
  const sendingRoomsRef = useRef<Set<string>>(new Set());
  const draftByRoomRef = useRef<Map<string, string>>(new Map());
  const dirtyDraftTokensRef = useRef<Set<string>>(new Set());
  const draftSaveTimersRef = useRef<Map<string, number>>(new Map());

  const cancelDraftTimer = useCallback((token: string) => {
    const timer = draftSaveTimersRef.current.get(token);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      draftSaveTimersRef.current.delete(token);
    }
  }, []);

  const flushDraftForRoom = useCallback(
    (token: string) => {
      cancelDraftTimer(token);
      if (!dirtyDraftTokensRef.current.has(token)) return;
      dirtyDraftTokensRef.current.delete(token);
      const value = draftByRoomRef.current.get(token) ?? "";
      void saveTalkDraft(token, value).catch(() => {});
    },
    [cancelDraftTimer],
  );

  const scheduleDraftSave = useCallback(
    (token: string, value: string) => {
      draftByRoomRef.current.set(token, value);
      dirtyDraftTokensRef.current.add(token);
      cancelDraftTimer(token);
      const timer = window.setTimeout(() => {
        draftSaveTimersRef.current.delete(token);
        dirtyDraftTokensRef.current.delete(token);
        void saveTalkDraft(token, draftByRoomRef.current.get(token) ?? "").catch(
          () => {},
        );
      }, 300);
      draftSaveTimersRef.current.set(token, timer);
    },
    [cancelDraftTimer],
  );

  const selectRoom = useCallback(
    (nextToken: string) => {
      const prevToken = selectedTokenRef.current;
      if (prevToken && prevToken !== nextToken) {
        flushDraftForRoom(prevToken);
      }
      setSendError(null);
      setMessagesError(null);
      if (prevToken !== nextToken) {
        setMessages([]);
        setMessagesRoomToken(null);
        setDraft(draftByRoomRef.current.get(nextToken) ?? "");
        if (textareaRef.current) {
          textareaRef.current.style.height = "auto";
        }
      }
      setSelectedToken(nextToken);
    },
    [flushDraftForRoom],
  );

  useEffect(() => {
    const timers = draftSaveTimersRef.current;
    const dirtyTokens = dirtyDraftTokensRef.current;
    const drafts = draftByRoomRef.current;
    return () => {
      for (const timer of timers.values()) {
        window.clearTimeout(timer);
      }
      timers.clear();
      for (const token of dirtyTokens) {
        void saveTalkDraft(token, drafts.get(token) ?? "").catch(() => {});
      }
      dirtyTokens.clear();
    };
  }, []);

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

  useEffect(() => {
    if (!isNextcloudConnected) return;
    let cancelled = false;
    setLoading(true);
    void listTalkRooms(null)
      .then((page) => {
        if (cancelled) return;
        setRooms(page.rooms);
        if (page.rooms.length > 0 && !selectedTokenRef.current) {
          selectRoom(page.rooms[0].token);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isNextcloudConnected, selectRoom]);

  const loadRoomMessages = useCallback(
    (token: string) => {
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
            selectedTokenRef.current !== token ||
            messagesReqSeqRef.current !== seq
          ) {
            return;
          }
          setMessages(page.messages);
          setMessagesRoomToken(token);
          window.setTimeout(
            () => endRef.current?.scrollIntoView({ behavior: "auto" }),
            20,
          );
        })
        .catch(() => {
          if (
            cancelled ||
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
            selectedTokenRef.current === token &&
            messagesReqSeqRef.current === seq
          ) {
            setLoadingMessages(false);
          }
        });
      return () => {
        cancelled = true;
      };
    },
    [],
  );

  useEffect(() => {
    if (!isNextcloudConnected || !selectedToken) return;
    const token = selectedToken;
    const cancelMessages = loadRoomMessages(token);

    let draftCancelled = false;
    if (!dirtyDraftTokensRef.current.has(token)) {
      void getTalkDraft(token)
        .then((saved) => {
          if (
            draftCancelled ||
            selectedTokenRef.current !== token ||
            dirtyDraftTokensRef.current.has(token)
          ) {
            return;
          }
          const resolved = saved ?? "";
          draftByRoomRef.current.set(token, resolved);
          setDraft(resolved);
        })
        .catch(() => {});
    }

    return () => {
      draftCancelled = true;
      cancelMessages();
    };
  }, [isNextcloudConnected, selectedToken, loadRoomMessages]);

  async function submitDraft() {
    const targetToken = selectedTokenRef.current;
    if (!targetToken || sendingRoomsRef.current.has(targetToken)) return;
    const submittedText = draft;
    const trimmed = submittedText.trim();
    if (!trimmed) return;
    sendingRoomsRef.current.add(targetToken);
    setSendingRooms((prev) => ({ ...prev, [targetToken]: true }));
    setSendError(null);
    cancelDraftTimer(targetToken);
    dirtyDraftTokensRef.current.delete(targetToken);
    try {
      const sent = await sendTalkMessage({
        token: targetToken,
        message: trimmed,
        replyTo: null,
        referenceId: null,
      });

      // Preserve any new text typed for this room while the send request was in flight
      const latestForRoom = draftByRoomRef.current.get(targetToken) ?? submittedText;
      let remaining = "";
      if (latestForRoom !== submittedText) {
        remaining = latestForRoom.startsWith(submittedText)
          ? latestForRoom.slice(submittedText.length).trimStart()
          : latestForRoom;
      }
      draftByRoomRef.current.set(targetToken, remaining);
      dirtyDraftTokensRef.current.delete(targetToken);
      void saveTalkDraft(targetToken, remaining).catch(() => {});

      if (selectedTokenRef.current === targetToken) {
        if (messagesRoomTokenRef.current === targetToken) {
          setMessages((prev) => [...prev, sent]);
        }
        setDraft(remaining);
        if (textareaRef.current && !remaining) {
          textareaRef.current.style.height = "auto";
        }
      }
    } catch {
      // Persist the unsent draft so closing or switching rooms never loses it
      const kept = draftByRoomRef.current.get(targetToken) ?? submittedText;
      draftByRoomRef.current.set(targetToken, kept);
      void saveTalkDraft(targetToken, kept).catch(() => {});
      if (selectedTokenRef.current === targetToken) {
        setSendError("Could not send message. Your draft was kept.");
      }
    } finally {
      sendingRoomsRef.current.delete(targetToken);
      setSendingRooms((prev) => {
        if (!prev[targetToken]) return prev;
        const next = { ...prev };
        delete next[targetToken];
        return next;
      });
    }
  }

  function handleSend(e: React.FormEvent) {
    e.preventDefault();
    void submitDraft();
  }

  const activeRoom = rooms.find((r) => r.token === selectedToken) ?? null;
  const sending = Boolean(selectedToken && sendingRooms[selectedToken]);
  const visibleMessages =
    selectedToken && messagesRoomToken === selectedToken
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
        {!isNextcloudConnected ? (
          <p className="px-4 py-10 text-center text-xs text-[var(--text-muted)]">
            Connect Nextcloud to access team chat.
          </p>
        ) : loading || loadingMessages ? (
          <div className="flex items-center justify-center gap-2 py-10 text-xs text-[var(--text-muted)]">
            <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.5} />
            {loading ? "Loading rooms…" : "Loading messages…"}
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
                onClick={() => void loadRoomMessages(selectedToken)}
                className="rounded border border-[var(--border-strong)] bg-[var(--bg-surface)] px-2.5 py-1 text-[11px] font-medium text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
              >
                Retry
              </button>
            )}
          </div>
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
                <div key={msg.id ?? msg.referenceId}>
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
      {isNextcloudConnected && activeRoom && !activeRoom.readOnly && (
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
                if (selectedTokenRef.current) {
                  scheduleDraftSave(selectedTokenRef.current, nextValue);
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
