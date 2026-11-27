import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  ArrowUp,
  Check,
  ChevronRight,
  Copy,
  ExternalLink,
  File as FileIcon,
  Folder,
  FolderOpen,
  Hash,
  Home,
  Loader2,
  MessageSquare,
  Paperclip,
  Pencil,
  Plus,
  RefreshCw,
  Reply,
  Search,
  Star,
  Upload,
  User,
  WifiOff,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  FileItemView_Serialize,
  PreviewKind,
  TalkCapabilities,
  TalkFileReference_Serialize,
  TalkMessage_Serialize,
  TalkRoomType,
  TalkRoom_Serialize,
  UserFacingError,
} from "../bindings/tauri";
import { ErrorBanner } from "../components/ErrorBanner";
import { FilePreviewPane } from "../components/files/FilePreviewPane";
import { NoticeBanner } from "../components/shell/NoticeBanner";
import { WorkspaceLayout } from "../components/shell/WorkspaceLayout";
import { InlineDeleteConfirm } from "../components/ui/InlineDeleteConfirm";
import { Modal } from "../components/ui/Modal";
import { Select } from "../components/ui/Select";
import { IconButton, Kbd, Tooltip } from "../components/ui/Tooltip";
import { formatIsoDate, formatTime24h } from "../lib/dateFormat";
import {
  areSingleKeyShortcutsEnabled,
  handleToolbarKeyDown,
  hasActiveOverlay,
  isEditableTarget,
  useSingleKeyShortcutsEnabled,
} from "../lib/shortcuts";
import { listFiles } from "../lib/filesClient";
import {
  createTalkRoom,
  deleteTalkMessage,
  editTalkMessage,
  getTalkCapabilities,
  getTalkDraft,
  getTalkMessages,
  listTalkRooms,
  markTalkRead,
  saveTalkDraft,
  sendTalkMessage,
  shareTalkFileReference,
  startTalkPolling,
  stopTalkPolling,
  toggleTalkReaction,
  toggleTalkRoomFavorite,
  uploadTalkAttachmentBytes,
} from "../lib/talkClient";
import {
  formatBytes,
  openExternalUrl,
  toUserFacingError,
} from "../lib/workspaceClient";

interface TalkViewProps {
  isNextcloudConnected: boolean;
  currentActorId: string | null;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  onSetInspectorOpen: (open: boolean) => void;
  banners?: React.ReactNode;
}

interface TalkMessagesEventPayload {
  token: string;
  messages: TalkMessage_Serialize[];
  lastGiven: number | null;
}

const QUICK_REACTIONS = ["👍", "❤️", "👀"];
const MAX_TALK_UPLOAD_BYTES = 50 * 1024 * 1024;

function inferPreviewKind(name: string): PreviewKind {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "pdf") return "pdf";
  if (["png", "jpg", "jpeg", "webp", "gif", "bmp", "tiff"].includes(ext))
    return "image";
  if (["mp4", "webm", "mov", "mkv"].includes(ext)) return "video";
  if (ext === "svg") return "vectorSvg";
  if (ext === "ai") return "vectorAi";
  if (ext === "dxf") return "vectorDxf";
  if (ext === "eps") return "vectorEps";
  if (["sldprt", "sldasm", "slddrw"].includes(ext)) return "solidWorks";
  if (["stl", "glb", "gltf", "obj", "step", "stp"].includes(ext))
    return "cad3d";
  if (["txt", "json", "csv", "yml", "yaml", "log"].includes(ext))
    return "plainText";
  return "unsupported";
}

function mergeMessages(
  existing: TalkMessage_Serialize[],
  incoming: TalkMessage_Serialize[],
): TalkMessage_Serialize[] {
  const byId = new Map<number, TalkMessage_Serialize>();
  for (const m of existing) {
    if (m.id !== null) byId.set(m.id, m);
  }
  for (const m of incoming) {
    if (m.id !== null) byId.set(m.id, m);
  }
  return Array.from(byId.values()).sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
}

function formatMessageTime(ts: number | null): string {
  return formatTime24h(ts);
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

/** Renders clean inline code (`...`) and fenced code blocks without HTML injection. */
function FormattedMessageBody({ text }: { text: string }) {
  const blocks = text.split(/(```[\s\S]*?```)/g);
  return (
    <div className="space-y-1.5 text-[13px] leading-relaxed break-words text-[var(--text-primary)]">
      {blocks.map((block, idx) => {
        if (block.startsWith("```") && block.endsWith("```")) {
          const inner = block.slice(3, -3).replace(/^[a-zA-Z0-9_-]+\n/, "");
          return (
            <pre
              key={idx}
              className="mono-num overflow-x-auto rounded-md border border-[var(--border-hairline)] bg-[var(--bg-app)] p-2.5 text-[11px] leading-relaxed text-[var(--text-primary)]"
            >
              <code>{inner}</code>
            </pre>
          );
        }
        const parts = block.split(/(`[^`\n]+`)/g);
        return (
          <p key={idx} className="whitespace-pre-wrap">
            {parts.map((part, pIdx) =>
              part.startsWith("`") && part.endsWith("`") ? (
                <code
                  key={pIdx}
                  className="mono-num rounded border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-1 py-0.5 text-[11px] text-[var(--text-primary)]"
                >
                  {part.slice(1, -1)}
                </code>
              ) : (
                <span key={pIdx}>{part}</span>
              ),
            )}
          </p>
        );
      })}
    </div>
  );
}

export function TalkView({
  isNextcloudConnected,
  currentActorId,
  sidebarOpen,
  onToggleSidebar,
  inspectorOpen,
  onToggleInspector,
  onSetInspectorOpen,
  banners,
}: TalkViewProps) {
  const [capabilities, setCapabilities] = useState<TalkCapabilities | null>(
    null,
  );
  const [rooms, setRooms] = useState<TalkRoom_Serialize[]>([]);
  const [roomsFromCache, setRoomsFromCache] = useState(false);
  const [loadingRooms, setLoadingRooms] = useState(true);
  const [roomSearch, setRoomSearch] = useState("");
  const [messageFilter, setMessageFilter] = useState("");
  const [showMessageFilter, setShowMessageFilter] = useState(false);

  const [selectedToken, setSelectedToken] = useState<string | null>(null);
  const [messages, setMessages] = useState<TalkMessage_Serialize[]>([]);
  const [messagesFromCache, setMessagesFromCache] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasOlder, setHasOlder] = useState(true);
  const [copiedMsgId, setCopiedMsgId] = useState<number | null>(null);
  const [confirmDeleteMsgId, setConfirmDeleteMsgId] = useState<number | null>(
    null,
  );
  const [unreadBoundaryId, setUnreadBoundaryId] = useState<number | null>(null);

  const [composerText, setComposerText] = useState("");
  const [replyTo, setReplyTo] = useState<TalkMessage_Serialize | null>(null);
  const [editingMsg, setEditingMsg] = useState<TalkMessage_Serialize | null>(
    null,
  );
  const [sending, setSending] = useState(false);
  const [uploadingAttachment, setUploadingAttachment] = useState(false);

  const [showNewRoomModal, setShowNewRoomModal] = useState(false);
  const [newRoomType, setNewRoomType] = useState<TalkRoomType>("group");
  const [newRoomName, setNewRoomName] = useState("");
  const [newRoomInvite, setNewRoomInvite] = useState("");
  const [creatingRoom, setCreatingRoom] = useState(false);

  // Zero-copy Nextcloud file picker
  const [showFilePicker, setShowFilePicker] = useState(false);
  const [pickerPath, setPickerPath] = useState("/");
  const [pickerItems, setPickerItems] = useState<FileItemView_Serialize[]>([]);
  const [loadingPicker, setLoadingPicker] = useState(false);
  const [referencingFileId, setReferencingFileId] = useState<string | null>(
    null,
  );

  // Inline FilePreviewPane in right drawer
  const [previewItem, setPreviewItem] = useState<FileItemView_Serialize | null>(
    null,
  );
  const [previewFileRef, setPreviewFileRef] =
    useState<TalkFileReference_Serialize | null>(null);
  const [previewExpanded, setPreviewExpanded] = useState(false);
  const [accessDeniedFile, setAccessDeniedFile] =
    useState<TalkFileReference_Serialize | null>(null);

  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<UserFacingError | null>(null);

  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const singleKeyEnabled = useSingleKeyShortcutsEnabled();
  const [focusedMsgKey, setFocusedMsgKey] = useState<string | null>(null);
  const draftTimersRef = useRef<Map<string, number>>(new Map());
  const pendingDraftsRef = useRef<Map<string, string>>(new Map());
  const userTypedInRoomRef = useRef<Set<string>>(new Set());
  const lastScrolledTokenRef = useRef<string | null>(null);
  const hasInitialRoomScrollRef = useRef<boolean>(false);
  const lastMessageIdRef = useRef<number>(0);
  const previewFileRefRef = useRef<TalkFileReference_Serialize | null>(null);
  previewFileRefRef.current = previewFileRef;
  const selectedTokenRef = useRef<string | null>(null);
  selectedTokenRef.current = selectedToken;
  const roomsRef = useRef<TalkRoom_Serialize[]>([]);
  roomsRef.current = rooms;

  const selectedRoom = useMemo(
    () => rooms.find((r) => r.token === selectedToken) ?? null,
    [rooms, selectedToken],
  );

  function flashNotice(msg: string) {
    setNotice(msg);
    window.setTimeout(() => {
      setNotice((prev) => (prev === msg ? null : prev));
    }, 4500);
  }

  const flushDraft = useCallback((token: string) => {
    const timer = draftTimersRef.current.get(token);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      draftTimersRef.current.delete(token);
    }
    if (!pendingDraftsRef.current.has(token)) return;
    const text = pendingDraftsRef.current.get(token) ?? "";
    pendingDraftsRef.current.delete(token);
    void saveTalkDraft(token, text).catch((err) => {
      setError(toUserFacingError(err));
    });
  }, []);

  const pauseDraftTimer = useCallback((token: string) => {
    const timer = draftTimersRef.current.get(token);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      draftTimersRef.current.delete(token);
    }
  }, []);

  const cancelPendingDraft = useCallback((token: string) => {
    const timer = draftTimersRef.current.get(token);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      draftTimersRef.current.delete(token);
    }
    pendingDraftsRef.current.delete(token);
  }, []);

  const handlePreviewError = useCallback((previewErr: UserFacingError) => {
    const activeRef = previewFileRefRef.current;
    if (!activeRef) return;
    if (
      previewErr.code === "not_found" ||
      previewErr.code === "permission_denied"
    ) {
      setAccessDeniedFile(activeRef);
      setPreviewItem(null);
      setPreviewFileRef(null);
      setPreviewExpanded(false);
    } else if (previewErr.code === "auth_required") {
      setError(previewErr);
    }
  }, []);

  useEffect(() => {
    const pendingDrafts = pendingDraftsRef.current;
    return () => {
      for (const token of Array.from(pendingDrafts.keys())) {
        flushDraft(token);
      }
    };
  }, [flushDraft]);

  const filteredRoomsRef = useRef<TalkRoom_Serialize[]>([]);
  const roomSearchRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (showFilePicker || showNewRoomModal || hasActiveOverlay()) {
        return;
      }
      if (e.key === "Escape") {
        if (e.defaultPrevented || document.querySelector('[role="tooltip"]')) {
          return;
        }
        if (editingMsg) {
          e.preventDefault();
          setEditingMsg(null);
          return;
        }
        if (replyTo) {
          e.preventDefault();
          setReplyTo(null);
          return;
        }
        if (showMessageFilter) {
          e.preventDefault();
          setShowMessageFilter(false);
          setMessageFilter("");
          return;
        }
      }
      const inInput = isEditableTarget(e.target);
      if (
        areSingleKeyShortcutsEnabled() &&
        e.key === "/" &&
        !inInput &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        e.preventDefault();
        roomSearchRef.current?.focus();
        return;
      }
      if (
        !e.defaultPrevented &&
        (e.key === "ArrowDown" || e.key === "ArrowUp") &&
        !inInput &&
        !e.altKey &&
        !e.metaKey &&
        !e.ctrlKey
      ) {
        // Strict allow-list: only switch rooms when focus is in the sidebar or on page body
        const activeEl = document.activeElement;
        const inSidebarOrBody =
          activeEl === document.body ||
          (activeEl instanceof HTMLElement &&
            Boolean(activeEl.closest('[aria-label="Module sidebar"]')));
        if (!inSidebarOrBody) {
          return;
        }
        const list = filteredRoomsRef.current;
        if (list.length === 0) return;
        e.preventDefault();
        const curIdx = selectedToken
          ? list.findIndex((r) => r.token === selectedToken)
          : -1;
        const nextIdx =
          e.key === "ArrowDown"
            ? curIdx < 0
              ? 0
              : Math.min(list.length - 1, curIdx + 1)
            : curIdx <= 0
              ? 0
              : curIdx - 1;
        const nextToken = list[nextIdx].token;
        setSelectedToken(nextToken);
        const btn = document.querySelector<HTMLElement>(
          `button[data-room-token="${CSS.escape(nextToken)}"]`,
        );
        btn?.focus({ preventScroll: false });
        btn?.scrollIntoView({ block: "nearest" });
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    showFilePicker,
    showNewRoomModal,
    selectedToken,
    confirmDeleteMsgId,
    editingMsg,
    replyTo,
    showMessageFilter,
  ]);

  const loadRoomsAndCaps = useCallback(async () => {
    if (!isNextcloudConnected) {
      setCapabilities(null);
      setRooms([]);
      setSelectedToken(null);
      setMessages([]);
      setPreviewItem(null);
      setPreviewFileRef(null);
      setAccessDeniedFile(null);
      setLoadingRooms(false);
      return;
    }
    setLoadingRooms(true);
    setError(null);
    try {
      const caps = await getTalkCapabilities();
      setCapabilities(caps);
      if (!caps.enabled) {
        setRooms([]);
        setSelectedToken(null);
        return;
      }
      const page = await listTalkRooms(null);
      setRooms(page.rooms);
      setRoomsFromCache(page.fromCache);
      if (
        page.rooms.length > 0 &&
        (!selectedTokenRef.current ||
          !page.rooms.some((r) => r.token === selectedTokenRef.current))
      ) {
        setSelectedToken(page.rooms[0].token);
      } else if (page.rooms.length === 0) {
        setSelectedToken(null);
      }
    } catch (err) {
      setError(toUserFacingError(err));
    } finally {
      setLoadingRooms(false);
    }
  }, [isNextcloudConnected]);

  useEffect(() => {
    if (currentActorId === null && !isNextcloudConnected) {
      setSelectedToken(null);
    }
    void loadRoomsAndCaps();
  }, [loadRoomsAndCaps, currentActorId, isNextcloudConnected]);

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void listen<TalkMessagesEventPayload>("talk://messages", (event) => {
      if (cancelled) return;
      if (event.payload.token !== selectedTokenRef.current) return;
      setMessages((prev) => mergeMessages(prev, event.payload.messages));
      const latestId = event.payload.messages.reduce(
        (acc, m) => Math.max(acc, m.id ?? 0),
        0,
      );
      if (latestId > 0) {
        void markTalkRead(event.payload.token, latestId).catch(() => {});
      }
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!isNextcloudConnected || !selectedToken) {
      void stopTalkPolling().catch(() => {});
      return;
    }
    let cancelled = false;
    const token = selectedToken;
    userTypedInRoomRef.current.delete(token);
    setLoadingMessages(true);
    setLoadingOlder(false);
    setMessages([]);
    setMessagesFromCache(false);
    setPreviewItem(null);
    setPreviewFileRef(null);
    setPreviewExpanded(false);
    setAccessDeniedFile(null);
    setReplyTo(null);
    setEditingMsg(null);
    setHasOlder(true);
    setComposerText(pendingDraftsRef.current.get(token) ?? "");

    void Promise.all([
      getTalkMessages(token, null, 50),
      getTalkDraft(token).catch(() => null),
    ])
      .then(async ([page, draft]) => {
        if (cancelled || selectedTokenRef.current !== token) return;
        const roomMeta = roomsRef.current.find((r) => r.token === token);
        const boundary =
          roomMeta &&
          roomMeta.unreadMessages > 0 &&
          roomMeta.lastReadMessage !== null &&
          roomMeta.lastReadMessage > 0
            ? roomMeta.lastReadMessage
            : null;
        setUnreadBoundaryId(boundary);
        setConfirmDeleteMsgId(null);
        setMessages(page.messages);
        setMessagesFromCache(page.fromCache);
        setHasOlder(page.messages.length >= 50);
        if (!userTypedInRoomRef.current.has(token)) {
          setComposerText(pendingDraftsRef.current.get(token) ?? draft ?? "");
        }

        const maxId = page.messages.reduce(
          (acc, m) => Math.max(acc, m.id ?? 0),
          0,
        );
        if (maxId > 0 && !page.fromCache) {
          void markTalkRead(token, maxId).catch(() => {});
          setRooms((prev) =>
            prev.map((r) =>
              r.token === token
                ? { ...r, unreadMessages: 0, unreadMention: false }
                : r,
            ),
          );
        }
        if (
          !page.fromCache &&
          !cancelled &&
          selectedTokenRef.current === token
        ) {
          await startTalkPolling(token, maxId > 0 ? maxId : null).catch(
            () => {},
          );
        }
      })
      .catch((err) => {
        if (!cancelled && selectedTokenRef.current === token) {
          setError(toUserFacingError(err));
        }
      })
      .finally(() => {
        if (!cancelled && selectedTokenRef.current === token) {
          setLoadingMessages(false);
        }
      });

    return () => {
      cancelled = true;
      flushDraft(token);
      void stopTalkPolling().catch(() => {});
    };
  }, [isNextcloudConnected, selectedToken, flushDraft]);

  useEffect(() => {
    if (lastScrolledTokenRef.current !== selectedToken) {
      lastScrolledTokenRef.current = selectedToken;
      lastMessageIdRef.current = 0;
      hasInitialRoomScrollRef.current = false;
      return;
    }
    if (messages.length === 0) return;
    const newestId = messages[messages.length - 1]?.id ?? 0;
    if (!hasInitialRoomScrollRef.current) {
      hasInitialRoomScrollRef.current = true;
      lastMessageIdRef.current = newestId;
      messagesEndRef.current?.scrollIntoView({ behavior: "auto" });
      return;
    }
    if (newestId > lastMessageIdRef.current) {
      lastMessageIdRef.current = newestId;
      const reduceMotion = window.matchMedia(
        "(prefers-reduced-motion: reduce)",
      ).matches;
      messagesEndRef.current?.scrollIntoView({
        behavior: reduceMotion ? "auto" : "smooth",
      });
    }
  }, [messages, selectedToken]);

  function handleComposerChange(next: string) {
    setComposerText(next);
    const token = selectedToken;
    if (!token || editingMsg) return;
    userTypedInRoomRef.current.add(token);
    pendingDraftsRef.current.set(token, next);
    const existingTimer = draftTimersRef.current.get(token);
    if (existingTimer !== undefined) {
      window.clearTimeout(existingTimer);
    }
    const timer = window.setTimeout(() => {
      draftTimersRef.current.delete(token);
      const latestText = pendingDraftsRef.current.get(token);
      pendingDraftsRef.current.delete(token);
      if (latestText === undefined) return;
      void saveTalkDraft(token, latestText).catch((err) => {
        setError(toUserFacingError(err));
      });
    }, 400);
    draftTimersRef.current.set(token, timer);
  }

  async function handleLoadOlder() {
    const token = selectedToken;
    if (!token || loadingOlder || messages.length === 0) return;
    const oldestId = messages[0]?.id;
    if (oldestId === null || oldestId === undefined) return;
    setLoadingOlder(true);
    try {
      const page = await getTalkMessages(token, oldestId, 50);
      if (selectedTokenRef.current !== token) return;
      if (page.messages.length === 0) {
        setHasOlder(false);
      } else {
        setMessages((prev) => mergeMessages(page.messages, prev));
        if (page.messages.length < 50) setHasOlder(false);
      }
    } catch (err) {
      if (selectedTokenRef.current === token) {
        setError(toUserFacingError(err));
      }
    } finally {
      setLoadingOlder(false);
    }
  }

  async function handleSendSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const token = selectedToken;
    const trimmed = composerText.trim();
    if (!token || !trimmed || sending) return;
    setError(null);
    setSending(true);
    const currentEditing = editingMsg;
    const currentReplyTo = replyTo;
    if (!currentEditing) {
      pauseDraftTimer(token);
      pendingDraftsRef.current.set(token, trimmed);
    }
    try {
      if (currentEditing && currentEditing.id !== null) {
        const edited = await editTalkMessage(token, currentEditing.id, trimmed);
        if (selectedTokenRef.current !== token) return;
        setMessages((prev) => mergeMessages(prev, [edited]));
        setEditingMsg(null);
        setComposerText("");
      } else {
        const sent = await sendTalkMessage({
          token,
          message: trimmed,
          replyTo: currentReplyTo?.id ?? null,
          referenceId: null,
        });
        cancelPendingDraft(token);
        void saveTalkDraft(token, "").catch(() => {});
        if (selectedTokenRef.current !== token) return;
        setMessages((prev) => mergeMessages(prev, [sent]));
        setReplyTo(null);
        setComposerText("");
      }
    } catch (err) {
      if (selectedTokenRef.current === token) {
        setError(toUserFacingError(err));
      }
    } finally {
      setSending(false);
    }
  }

  async function handleDeleteMessage(msg: TalkMessage_Serialize) {
    const token = selectedToken;
    if (!token || msg.id === null) return;
    setError(null);
    try {
      const deleted = await deleteTalkMessage(token, msg.id);
      if (selectedTokenRef.current !== token) return;
      setMessages((prev) => mergeMessages(prev, [deleted]));
    } catch (err) {
      if (selectedTokenRef.current === token) {
        setError(toUserFacingError(err));
      }
    }
  }

  async function handleToggleReaction(
    msg: TalkMessage_Serialize,
    emoji: string,
  ) {
    const token = selectedToken;
    if (!token || msg.id === null) return;
    const alreadyReacted = msg.reactionsSelf.includes(emoji);
    setError(null);
    try {
      await toggleTalkReaction(token, msg.id, emoji, !alreadyReacted);
      if (selectedTokenRef.current !== token) return;
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== msg.id) return m;
          const nextReactions = { ...m.reactions };
          const cur = nextReactions[emoji] ?? 0;
          if (alreadyReacted) {
            if (cur <= 1) delete nextReactions[emoji];
            else nextReactions[emoji] = cur - 1;
          } else {
            nextReactions[emoji] = cur + 1;
          }
          const nextSelf = alreadyReacted
            ? m.reactionsSelf.filter((e) => e !== emoji)
            : [...m.reactionsSelf, emoji];
          return { ...m, reactions: nextReactions, reactionsSelf: nextSelf };
        }),
      );
    } catch (err) {
      if (selectedTokenRef.current === token) {
        setError(toUserFacingError(err));
      }
    }
  }

  async function handleCreateRoom(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setCreatingRoom(true);
    try {
      const created = await createTalkRoom({
        roomType: newRoomType,
        roomName: newRoomType === "group" ? newRoomName.trim() : null,
        invite: newRoomType === "oneToOne" ? newRoomInvite.trim() : null,
      });
      setRooms((prev) => [
        created,
        ...prev.filter((r) => r.token !== created.token),
      ]);
      setSelectedToken(created.token);
      setShowNewRoomModal(false);
      setNewRoomName("");
      setNewRoomInvite("");
    } catch (err) {
      setError(toUserFacingError(err));
    } finally {
      setCreatingRoom(false);
    }
  }

  async function handleToggleFavorite(room: TalkRoom_Serialize) {
    setError(null);
    try {
      await toggleTalkRoomFavorite(room.token, !room.isFavorite);
      setRooms((prev) =>
        prev.map((r) =>
          r.token === room.token ? { ...r, isFavorite: !r.isFavorite } : r,
        ),
      );
    } catch (err) {
      setError(toUserFacingError(err));
    }
  }

  const loadPickerFolder = useCallback(async (path: string) => {
    setLoadingPicker(true);
    setError(null);
    try {
      const items = await listFiles(path);
      setPickerPath(path);
      setPickerItems(items);
    } catch (err) {
      setError(toUserFacingError(err));
    } finally {
      setLoadingPicker(false);
    }
  }, []);

  async function handleOpenFilePicker() {
    setShowFilePicker(true);
    await loadPickerFolder("/");
  }

  async function handleReferenceCloudFile(item: FileItemView_Serialize) {
    const token = selectedToken;
    if (!token) return;
    setReferencingFileId(item.entry.id);
    setError(null);
    try {
      const shared = await shareTalkFileReference(token, item.entry.id);
      if (selectedTokenRef.current !== token) return;
      setMessages((prev) => mergeMessages(prev, [shared]));
      setShowFilePicker(false);
      flashNotice(`Referenced "${item.entry.name}" (zero copies).`);
    } catch (err) {
      if (selectedTokenRef.current === token) {
        setError(toUserFacingError(err));
      }
    } finally {
      setReferencingFileId(null);
    }
  }

  async function handleFileUploadSelected(
    event: React.ChangeEvent<HTMLInputElement>,
  ) {
    const file = event.target.files?.[0];
    event.target.value = "";
    const room = selectedRoom;
    if (!file || !room) return;
    const token = room.token;
    if (file.size > MAX_TALK_UPLOAD_BYTES) {
      setError({
        code: "invalid_input",
        title: "File is too large for Talk chat",
        message: `"${file.name}" (${formatBytes(file.size)}) exceeds the 50 MiB limit.`,
        recoveryHint:
          "Upload larger files in Files first, then reference them here with zero copies.",
        technicalDetails: null,
      });
      return;
    }
    setUploadingAttachment(true);
    setError(null);
    try {
      const buf = await file.arrayBuffer();
      const cloudPath = await uploadTalkAttachmentBytes(
        token,
        room.displayName,
        file.name,
        new Uint8Array(buf),
      );
      if (selectedTokenRef.current !== token) return;
      flashNotice(`Uploaded & attached "${file.name}" (${cloudPath}).`);
      const refreshed = await getTalkMessages(token, null, 50);
      if (selectedTokenRef.current !== token) return;
      setMessages((prev) => mergeMessages(prev, refreshed.messages));
    } catch (err) {
      if (selectedTokenRef.current === token) {
        setError(toUserFacingError(err));
      }
    } finally {
      setUploadingAttachment(false);
    }
  }

  function handleOpenFileReference(fileRef: TalkFileReference_Serialize) {
    setAccessDeniedFile(null);
    onSetInspectorOpen(true);
    if (!fileRef.path) {
      setAccessDeniedFile(fileRef);
      return;
    }
    const kind = inferPreviewKind(fileRef.name);
    setPreviewFileRef(fileRef);
    setPreviewItem({
      entry: {
        id: fileRef.fileId,
        name: fileRef.name,
        path: fileRef.path,
        kind: "file",
        size: fileRef.size,
        mimeType: fileRef.mimeType,
        etag: null,
        modifiedAt: null,
      },
      previewKind: kind,
      editable: kind === "markdown",
    });
  }

  async function handleCopyMessage(msg: TalkMessage_Serialize) {
    if (!navigator.clipboard) return;
    await navigator.clipboard.writeText(msg.message).catch(() => {});
    setCopiedMsgId(msg.id);
    window.setTimeout(() => {
      setCopiedMsgId((prev) => (prev === msg.id ? null : prev));
    }, 1800);
  }

  const filteredRooms = useMemo(() => {
    const q = roomSearch.trim().toLowerCase();
    if (!q) return rooms;
    return rooms.filter(
      (r) =>
        r.displayName.toLowerCase().includes(q) ||
        r.description.toLowerCase().includes(q),
    );
  }, [rooms, roomSearch]);

  const favoriteRooms = useMemo(() => {
    filteredRoomsRef.current = filteredRooms;
    return filteredRooms.filter((r) => r.isFavorite);
  }, [filteredRooms]);
  const regularRooms = useMemo(
    () => filteredRooms.filter((r) => !r.isFavorite),
    [filteredRooms],
  );

  const visibleMessages = useMemo(() => {
    const q = messageFilter.trim().toLowerCase();
    if (!q) return messages;
    return messages.filter(
      (m) =>
        m.message.toLowerCase().includes(q) ||
        m.actorDisplayName.toLowerCase().includes(q) ||
        (m.fileReference?.name.toLowerCase().includes(q) ?? false),
    );
  }, [messages, messageFilter]);

  const sharedFilesInRoom = useMemo(
    () =>
      messages
        .map((m) => m.fileReference)
        .filter((f): f is TalkFileReference_Serialize => Boolean(f)),
    [messages],
  );

  if (!isNextcloudConnected) {
    return (
      <WorkspaceLayout
        moduleId="talk"
        headerLeft={
          <h1 className="text-[13px] font-medium text-[var(--text-primary)]">
            Chat
          </h1>
        }
        sidebarOpen={false}
        onToggleSidebar={onToggleSidebar}
        inspectorOpen={false}
        banners={banners}
      >
        <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
          <MessageSquare
            className="mb-2.5 h-7 w-7 text-[var(--text-muted)]"
            strokeWidth={1.5}
          />
          <p className="text-xs font-medium text-[var(--text-primary)]">
            Sign in to Nextcloud to open Chat
          </p>
          <p className="mt-1 max-w-sm text-[11px] text-[var(--text-muted)]">
            Connect directly to Nextcloud Talk conversations with linked cloud
            files.
          </p>
        </div>
      </WorkspaceLayout>
    );
  }

  if (capabilities && !capabilities.enabled) {
    return (
      <WorkspaceLayout
        moduleId="talk"
        headerLeft={
          <h1 className="text-[13px] font-medium text-[var(--text-primary)]">
            Chat
          </h1>
        }
        sidebarOpen={false}
        onToggleSidebar={onToggleSidebar}
        inspectorOpen={false}
        banners={banners}
      >
        <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
          <MessageSquare
            className="mb-2.5 h-7 w-7 text-[var(--text-muted)]"
            strokeWidth={1.5}
          />
          <p className="text-xs font-medium text-[var(--text-primary)]">
            Nextcloud Talk is not enabled on this server
          </p>
          <p className="mt-1 max-w-sm text-[11px] text-[var(--text-muted)]">
            Enable the Nextcloud Talk (spreed) app, then refresh.
          </p>
          <button
            type="button"
            onClick={() => void loadRoomsAndCaps()}
            className="mt-3 inline-flex h-7 items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 text-xs font-medium text-white hover:bg-[var(--accent-hover)]"
          >
            <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.5} />
            Check again
          </button>
        </div>
      </WorkspaceLayout>
    );
  }

  const renderRoomRow = (room: TalkRoom_Serialize) => {
    const active = room.token === selectedToken;
    const isDm = room.roomType === "oneToOne";
    return (
      <div
        key={room.token}
        role="listitem"
        className={`group relative flex items-center justify-between gap-1 rounded-md px-2 py-1 text-xs transition-colors ${
          active
            ? "bg-[var(--bg-elevated)] font-medium text-[var(--text-primary)]"
            : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        }`}
      >
        {active && (
          <span
            aria-hidden="true"
            className="absolute top-1.5 bottom-1.5 left-0 w-[2px] rounded-r bg-[var(--accent)]"
          />
        )}
        <button
          type="button"
          data-room-token={room.token}
          aria-current={active ? "page" : undefined}
          tabIndex={
            active ||
            (!selectedToken && filteredRoomsRef.current[0]?.token === room.token)
              ? 0
              : -1
          }
          onClick={() => setSelectedToken(room.token)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              const list = filteredRoomsRef.current;
              const idx = list.findIndex((r) => r.token === room.token);
              if (idx === -1) return;
              const nextIdx =
                e.key === "ArrowDown"
                  ? Math.min(list.length - 1, idx + 1)
                  : Math.max(0, idx - 1);
              if (nextIdx !== idx) {
                e.preventDefault();
                const nextToken = list[nextIdx].token;
                setSelectedToken(nextToken);
                const btn = document.querySelector<HTMLElement>(
                  `button[data-room-token="${CSS.escape(nextToken)}"]`,
                );
                btn?.focus({ preventScroll: false });
                btn?.scrollIntoView({ block: "nearest" });
              }
            }
          }}
          className="flex min-w-0 flex-1 items-center gap-2 py-0.5 text-left"
        >
          {isDm ? (
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
          <span className="truncate">{room.displayName}</span>
        </button>
        <div className="flex shrink-0 items-center gap-1.5">
          {room.unreadMessages > 0 && (
            <span className="mono-num inline-flex items-center gap-1 text-[11px] leading-none font-medium text-[var(--accent-text)]">
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
              {room.unreadMessages}
            </span>
          )}
          <IconButton
            size="xs"
            side="right"
            tabIndex={active ? 0 : -1}
            label={room.isFavorite ? "Unpin room" : "Pin room"}
            onClick={() => void handleToggleFavorite(room)}
            className={`!h-5 !w-5 transition-opacity focus-visible:opacity-100 ${
              room.isFavorite
                ? "text-[var(--accent-text)] opacity-85 hover:opacity-100"
                : "text-[var(--text-muted)] opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 hover:text-[var(--text-primary)]"
            }`}
          >
            <Star
              className={`h-3 w-3 ${room.isFavorite ? "fill-current" : ""}`}
              strokeWidth={1.5}
            />
          </IconButton>
        </div>
      </div>
    );
  };

  const sidebarNode = (
    <div className="flex h-full flex-col">
      {/* Compact Sidebar Search + New Room */}
      <div className="flex items-center gap-1 border-b border-[var(--border-hairline)] p-2">
        <div className="relative min-w-0 flex-1">
          <Search
            className="pointer-events-none absolute top-1/2 left-2 h-3 w-3 -translate-y-1/2 text-[var(--text-muted)]"
            strokeWidth={1.5}
          />
          <input
            ref={roomSearchRef}
            type="text"
            aria-label="Filter rooms"
            value={roomSearch}
            onChange={(e) => setRoomSearch(e.target.value)}
            placeholder="Filter rooms…"
            className="h-7 w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-surface)] pr-6 pl-6 text-[11px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none"
          />
          {!roomSearch && singleKeyEnabled && (
            <Kbd className="pointer-events-none absolute top-1/2 right-1.5 -translate-y-1/2">
              /
            </Kbd>
          )}
        </div>
        <IconButton
          size="xs"
          label="New conversation"
          onClick={() => setShowNewRoomModal(true)}
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={1.5} />
        </IconButton>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-2.5">
        {loadingRooms ? (
          <div
            role="status"
            aria-live="polite"
            className="py-8 text-center text-[11px] text-[var(--text-muted)]"
          >
            Loading rooms…
          </div>
        ) : filteredRooms.length === 0 ? (
          <div className="py-8 text-center text-[11px] text-[var(--text-muted)]">
            No conversations found.
          </div>
        ) : (
          <>
            {favoriteRooms.length > 0 && (
              <div>
                <h2 className="mb-1 px-2 text-[11px] font-medium tracking-wider text-[var(--text-muted)] uppercase">
                  Pinned
                </h2>
                <div role="list" aria-label="Pinned rooms" className="space-y-0.5">
                  {favoriteRooms.map(renderRoomRow)}
                </div>
              </div>
            )}
            {regularRooms.length > 0 && (
              <div>
                <h2 className="mb-1 px-2 text-[11px] font-medium tracking-wider text-[var(--text-muted)] uppercase">
                  Conversations
                </h2>
                <div role="list" aria-label="Conversations" className="space-y-0.5">
                  {regularRooms.map(renderRoomRow)}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {roomsFromCache && (
        <div className="flex items-center gap-1.5 border-t border-[var(--border-hairline)] px-3 py-1.5 text-[11px] text-[var(--status-warning-text)]">
          <WifiOff className="h-3.5 w-3.5 shrink-0" strokeWidth={1.5} />
          <span>Offline cached rooms</span>
        </div>
      )}
      <div className="mono-num flex h-8 shrink-0 items-center justify-between border-t border-[var(--border-hairline)] bg-[var(--bg-app)] px-3 text-[11px] text-[var(--text-muted)]">
        <span>{rooms.length} rooms</span>
        <span>
          {rooms.reduce((acc, r) => acc + r.unreadMessages, 0)} unread
        </span>
      </div>
    </div>
  );

  const inspectorNode = previewItem ? (
    <FilePreviewPane
      item={previewItem}
      expanded={previewExpanded}
      onToggleExpand={() => setPreviewExpanded((prev) => !prev)}
      onClose={() => {
        setPreviewItem(null);
        setPreviewFileRef(null);
        setPreviewExpanded(false);
      }}
      onRefreshFolder={() => {}}
      onPreviewError={handlePreviewError}
    />
  ) : (
    <div className="flex h-full flex-col bg-[var(--bg-sidebar)]">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-[var(--border-hairline)] px-3">
        <span className="text-xs font-medium text-[var(--text-primary)]">
          Room Details
        </span>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3.5 text-xs">
        {selectedRoom ? (
          <>
            <div>
              <p className="font-medium text-[var(--text-primary)]">
                {selectedRoom.displayName}
              </p>
              {selectedRoom.description && (
                <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-secondary)]">
                  {selectedRoom.description}
                </p>
              )}
            </div>

            <div className="border-t border-[var(--border-hairline)] pt-3">
              <p className="mb-2 text-[10px] font-medium tracking-wider text-[var(--text-muted)] uppercase">
                Referenced Cloud Files
              </p>
              {sharedFilesInRoom.length === 0 ? (
                <p className="text-[11px] text-[var(--text-muted)]">
                  No files referenced in this conversation yet.
                </p>
              ) : (
                <div className="space-y-1">
                  {sharedFilesInRoom.map((f) => (
                    <button
                      key={`${f.fileId}-${f.name}`}
                      type="button"
                      onClick={() => handleOpenFileReference(f)}
                      className="flex w-full items-center gap-2 rounded-md border border-[var(--border-strong)] bg-[var(--bg-surface)] px-2.5 py-2 text-left transition-colors hover:bg-[var(--bg-elevated)]"
                    >
                      <FileIcon
                        className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]"
                        strokeWidth={1.5}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[11px] font-medium text-[var(--text-primary)]">
                          {f.name}
                        </p>
                        <p className="mono-num truncate text-[11px] text-[var(--text-muted)]">
                          {f.size ? formatBytes(f.size) : f.path ?? "Cloud file"}
                        </p>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </>
        ) : (
          <p className="text-[11px] text-[var(--text-muted)]">
            Select a conversation to inspect shared files.
          </p>
        )}
      </div>

      <div className="mono-num flex h-8 shrink-0 items-center justify-between border-t border-[var(--border-hairline)] bg-[var(--bg-app)] px-3 text-[11px] text-[var(--text-muted)]">
        <span className="truncate">
          {selectedRoom ? selectedRoom.displayName : "Chat"}
        </span>
        <span>{sharedFilesInRoom.length} files</span>
      </div>
    </div>
  );

  return (
    <WorkspaceLayout
      moduleId="talk"
      headerLeft={
        <div className="flex min-w-0 items-center gap-2">
          {selectedRoom ? (
            <>
              <h1 className="sr-only">Chat</h1>
              {selectedRoom.roomType === "oneToOne" ? (
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
              <h2 className="truncate text-[13px] font-medium text-[var(--text-primary)]">
                {selectedRoom.displayName}
              </h2>
              {selectedRoom.description && (
                <span className="hidden truncate text-xs text-[var(--text-muted)] md:inline">
                  · {selectedRoom.description}
                </span>
              )}
              {messagesFromCache && (
                <span className="inline-flex shrink-0 items-center gap-1 rounded border border-[var(--status-warning)]/35 bg-[var(--status-warning-soft)] px-1.5 py-0.5 text-[10px] text-[var(--status-warning-text)]">
                  <WifiOff className="h-2.5 w-2.5" strokeWidth={1.5} />
                  Cached
                </span>
              )}
            </>
          ) : (
            <h1 className="text-[13px] font-medium text-[var(--text-primary)]">
              Chat
            </h1>
          )}
        </div>
      }
      headerRight={
        <div className="flex items-center gap-1">
          {showMessageFilter && (
            <input
              type="text"
              autoFocus
              aria-label="Filter messages in room"
              value={messageFilter}
              onChange={(e) => setMessageFilter(e.target.value)}
              placeholder="Filter messages…"
              className="h-7 w-40 rounded-md border border-[var(--border-strong)] bg-[var(--bg-surface)] px-2 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none"
            />
          )}
          <div
            role="toolbar"
            aria-label="Chat actions"
            onKeyDown={handleToolbarKeyDown}
            className="flex items-center gap-1"
          >
          <IconButton
            label="Filter messages in room"
            active={showMessageFilter}
            onClick={() => {
              setShowMessageFilter((v) => {
                if (v) setMessageFilter("");
                return !v;
              });
            }}
          >
            <Search className="h-3.5 w-3.5" strokeWidth={1.5} />
          </IconButton>
          <IconButton
            label="Refresh conversations"
            disabled={loadingRooms}
            onClick={() => void loadRoomsAndCaps()}
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${loadingRooms ? "animate-spin" : ""}`}
              strokeWidth={1.5}
            />
          </IconButton>
          </div>
        </div>
      }
      sidebar={sidebarNode}
      sidebarOpen={sidebarOpen}
      onToggleSidebar={onToggleSidebar}
      inspector={inspectorNode}
      inspectorOpen={inspectorOpen}
      onToggleInspector={onToggleInspector}
      inspectorExpanded={Boolean(previewItem && previewExpanded)}
      banners={banners}
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {error && (
          <div className="border-b border-[var(--border-hairline)] p-2.5">
            <ErrorBanner error={error} onDismiss={() => setError(null)} />
          </div>
        )}

        {notice && (
          <NoticeBanner message={notice} onDismiss={() => setNotice(null)} />
        )}

        {accessDeniedFile && (
          <div className="flex items-center justify-between gap-2 border-b border-[var(--status-warning)]/35 bg-[var(--status-warning-soft)] px-4 py-2 text-xs text-[var(--text-primary)]">
            <span>
              <strong>{accessDeniedFile.name}</strong> couldn&apos;t be opened in
              Files — your account may lack folder permission.
            </span>
            <div className="flex shrink-0 items-center gap-2">
              {accessDeniedFile.link && (
                <button
                  type="button"
                  onClick={() => void openExternalUrl(accessDeniedFile.link!)}
                  className="inline-flex items-center gap-1 font-medium text-[var(--accent-text)] hover:underline"
                >
                  Open in Nextcloud
                  <ExternalLink className="h-3 w-3" strokeWidth={1.5} />
                </button>
              )}
              <IconButton
                size="xs"
                label="Dismiss"
                onClick={() => setAccessDeniedFile(null)}
              >
                <X className="h-3.5 w-3.5" strokeWidth={1.5} />
              </IconButton>
            </div>
          </div>
        )}

        {!selectedRoom ? (
          <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
            <MessageSquare
              className="mb-2 h-7 w-7 text-[var(--text-muted)] opacity-50"
              strokeWidth={1.5}
            />
            <p className="text-xs text-[var(--text-muted)]">
              Select a conversation to start messaging.
            </p>
          </div>
        ) : (
          <>
            {/* Flat Structured Linear/T3-Inspired Message Stream (ZERO chat bubbles) */}
            <div className="min-h-0 flex-1 overflow-y-auto py-3">
              {hasOlder && messages.length > 0 && !messagesFromCache && (
                <div className="mb-3 text-center">
                  <button
                    type="button"
                    disabled={loadingOlder}
                    onClick={() => void handleLoadOlder()}
                    className="rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-1 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-50"
                  >
                    {loadingOlder ? "Loading older…" : "Load older messages"}
                  </button>
                </div>
              )}

              {loadingMessages ? (
                <div
                  role="status"
                  aria-live="polite"
                  className="flex items-center justify-center gap-2 py-12 text-xs text-[var(--text-muted)]"
                >
                  <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.5} />
                  Loading messages…
                </div>
              ) : visibleMessages.length === 0 ? (
                <p className="py-12 text-center text-xs text-[var(--text-muted)]">
                  No messages yet. Start the thread or reference a Nextcloud
                  file below.
                </p>
              ) : (
                <div
                  role="log"
                  aria-label="Chat messages"
                  aria-live="polite"
                  aria-relevant="additions"
                  className="divide-y divide-[var(--border-subtle)]/60"
                >
                  {visibleMessages.map((msg, idx) => {
                    const isMine =
                      Boolean(currentActorId) &&
                      msg.actorId === currentActorId;
                    const isSystem = msg.messageType === "system";
                    if (isSystem) {
                      return (
                        <div
                          key={msg.id ?? msg.referenceId}
                          className="mono-num px-5 py-1.5 text-[11px] text-[var(--text-muted)]"
                        >
                          {formatMessageTime(msg.timestamp)} ·{" "}
                          {msg.actorDisplayName} {msg.message}
                        </div>
                      );
                    }

                    const prev = idx > 0 ? visibleMessages[idx - 1] : null;
                    const msgDay = msg.timestamp
                      ? formatIsoDate(new Date(msg.timestamp * 1000))
                      : null;
                    const prevDay = prev?.timestamp
                      ? formatIsoDate(new Date(prev.timestamp * 1000))
                      : null;
                    const showDateDivider = Boolean(msgDay && msgDay !== prevDay);
                    const showUnreadDivider =
                      unreadBoundaryId !== null &&
                      msg.id !== null &&
                      msg.id > unreadBoundaryId &&
                      (prev === null ||
                        prev.id === null ||
                        prev.id <= unreadBoundaryId);
                    const groupedWithPrev =
                      !showDateDivider &&
                      !showUnreadDivider &&
                      Boolean(prev) &&
                      prev?.messageType !== "system" &&
                      prev?.actorId === msg.actorId &&
                      Math.abs((msg.timestamp ?? 0) - (prev?.timestamp ?? 0)) <
                        300;

                    return (
                      <div key={msg.id ?? msg.referenceId}>
                        {showDateDivider && msgDay && (
                          <div className="flex items-center gap-2.5 px-5 py-1.5">
                            <span
                              aria-hidden="true"
                              className="h-px flex-1 bg-[var(--border-hairline)]"
                            />
                            <span className="mono-num text-[10px] font-medium text-[var(--text-muted)]">
                              {msgDay}
                            </span>
                            <span
                              aria-hidden="true"
                              className="h-px flex-1 bg-[var(--border-hairline)]"
                            />
                          </div>
                        )}
                        {showUnreadDivider && (
                          <div className="flex items-center gap-2.5 px-5 py-1.5">
                            <span
                              aria-hidden="true"
                              className="h-px flex-1 bg-[var(--accent-border)]"
                            />
                            <span className="text-[10px] font-medium tracking-wider text-[var(--accent-text)] uppercase">
                              New messages
                            </span>
                            <span
                              aria-hidden="true"
                              className="h-px flex-1 bg-[var(--accent-border)]"
                            />
                          </div>
                        )}
                        <article
                          tabIndex={
                            (focusedMsgKey
                              ? focusedMsgKey ===
                                String(msg.id ?? msg.referenceId)
                              : idx === visibleMessages.length - 1)
                              ? 0
                              : -1
                          }
                          onFocus={() =>
                            setFocusedMsgKey(String(msg.id ?? msg.referenceId))
                          }
                          className={`group relative flex gap-3 px-5 transition-colors hover:bg-[var(--bg-hover)]/70 ${
                            groupedWithPrev ? "py-1" : "py-2.5"
                          }`}
                        >
                        {/* Left Column: Monochrome Monogram or Compact Timestamp */}
                        <div className="w-6 shrink-0 pt-0.5">
                          {groupedWithPrev ? (
                            <span className="mono-num text-[11px] text-[var(--text-muted)] opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                              {formatMessageTime(msg.timestamp)}
                            </span>
                          ) : (
                            <div
                              className={`mono-num flex h-6 w-6 items-center justify-center rounded border text-[10px] font-medium ${
                                isMine
                                  ? "border-[var(--accent-border)] bg-[var(--accent-soft)] text-[var(--accent-text)]"
                                  : "border-[var(--border-hairline)] bg-[var(--bg-elevated)] text-[var(--text-secondary)]"
                              }`}
                            >
                              {initialsOf(msg.actorDisplayName)}
                            </div>
                          )}
                        </div>

                        {/* Message Body */}
                        <div className="min-w-0 flex-1">
                          {!groupedWithPrev && (
                            <div className="mb-0.5 flex items-baseline gap-2">
                              <span className="text-xs font-medium text-[var(--text-primary)]">
                                {msg.actorDisplayName}
                              </span>
                              {isMine && (
                                <span className="text-[11px] text-[var(--text-muted)]">
                                  you
                                </span>
                              )}
                              <span className="mono-num text-[11px] text-[var(--text-muted)]">
                                {formatMessageTime(msg.timestamp)}
                              </span>
                            </div>
                          )}

                          {/* Reply Quote */}
                          {msg.parent && (
                            <div className="mb-1.5 border-l-2 border-[var(--border-strong)] pl-2.5 text-[11px] text-[var(--text-muted)]">
                              <span className="font-medium text-[var(--text-secondary)]">
                                {msg.parent.actorDisplayName}
                              </span>{" "}
                              <span className="line-clamp-1">
                                {msg.parent.deleted
                                  ? "Message deleted"
                                  : msg.parent.message}
                              </span>
                            </div>
                          )}

                          {msg.deleted ? (
                            <p className="text-xs italic text-[var(--text-muted)]">
                              Message deleted
                            </p>
                          ) : (
                            <>
                              {(!msg.fileReference ||
                                msg.message !== msg.fileReference.name) && (
                                <FormattedMessageBody text={msg.message} />
                              )}

                              {/* Zero-Copy Cloud File Reference Card */}
                              {msg.fileReference && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    handleOpenFileReference(msg.fileReference!)
                                  }
                                  className="mt-1.5 flex w-full max-w-md items-center gap-2.5 rounded-md border border-[var(--border-strong)] bg-[var(--bg-sidebar)] px-3 py-2 text-left transition-colors hover:bg-[var(--bg-elevated)]"
                                >
                                  <FileIcon
                                    className="h-4 w-4 shrink-0 text-[var(--accent)]"
                                    strokeWidth={1.5}
                                  />
                                  <div className="min-w-0 flex-1">
                                    <p className="truncate text-xs font-medium text-[var(--text-primary)]">
                                      {msg.fileReference.name}
                                    </p>
                                    <p className="mono-num truncate text-[11px] text-[var(--text-muted)]">
                                      {msg.fileReference.path ??
                                        `#${msg.fileReference.fileId}`}
                                      {msg.fileReference.size
                                        ? ` · ${formatBytes(msg.fileReference.size)}`
                                        : ""}
                                    </p>
                                  </div>
                                  <span className="shrink-0 rounded border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-1.5 py-0.5 text-[10px] text-[var(--text-secondary)]">
                                    Preview
                                  </span>
                                </button>
                              )}

                              {/* Existing Reactions */}
                              {Object.keys(msg.reactions).length > 0 && (
                                <div className="mt-1.5 flex flex-wrap items-center gap-1">
                                  {Object.entries(msg.reactions).map(
                                    ([emoji, count]) => (
                                      <button
                                        key={emoji}
                                        type="button"
                                        aria-pressed={msg.reactionsSelf.includes(
                                          emoji,
                                        )}
                                        disabled={
                                          !capabilities?.reactionsSupported
                                        }
                                        onClick={() =>
                                          void handleToggleReaction(msg, emoji)
                                        }
                                        className={`mono-num inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] transition-colors ${
                                          msg.reactionsSelf.includes(emoji)
                                            ? "border-[var(--accent)] bg-[var(--accent-soft)] font-medium text-[var(--text-primary)]"
                                            : "border-[var(--border-strong)] bg-[var(--bg-sidebar)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                                        }`}
                                      >
                                        <span>{emoji}</span>
                                        <span>{count}</span>
                                      </button>
                                    ),
                                  )}
                                </div>
                              )}
                            </>
                          )}
                        </div>

                        {/* Subtle Hover- & Focus-Revealed Icon Action Bar (solid hairline, no blur) */}
                        {!msg.deleted && (() => {
                          const msgTabStop = focusedMsgKey
                            ? focusedMsgKey === String(msg.id ?? msg.referenceId)
                            : idx === visibleMessages.length - 1;
                          const actionTabIndex = msgTabStop ? 0 : -1;
                          return (
                          <div className="pointer-events-none absolute top-1.5 right-4 flex items-center gap-0.5 rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] p-0.5 opacity-0 transition-opacity group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100">
                            {capabilities?.reactionsSupported &&
                              QUICK_REACTIONS.map((emoji) => (
                                <Tooltip key={emoji} label={`React ${emoji}`}>
                                  <button
                                    type="button"
                                    tabIndex={actionTabIndex}
                                    aria-label={`React ${emoji}`}
                                    onClick={() =>
                                      void handleToggleReaction(msg, emoji)
                                    }
                                    className="flex h-6 w-6 items-center justify-center rounded text-[11px] hover:bg-[var(--bg-hover)]"
                                  >
                                    {emoji}
                                  </button>
                                </Tooltip>
                              ))}
                            <IconButton
                              size="xs"
                              tabIndex={actionTabIndex}
                              label="Copy message"
                              onClick={() => void handleCopyMessage(msg)}
                            >
                              {copiedMsgId === msg.id ? (
                                <Check
                                  className="h-3 w-3 text-[var(--status-positive-text)]"
                                  strokeWidth={1.5}
                                />
                              ) : (
                                <Copy className="h-3 w-3" strokeWidth={1.5} />
                              )}
                            </IconButton>
                            {msg.isReplyable && (
                              <IconButton
                                size="xs"
                                tabIndex={actionTabIndex}
                                label="Reply"
                                onClick={() => {
                                  setEditingMsg(null);
                                  setReplyTo(msg);
                                  requestAnimationFrame(() =>
                                    composerRef.current?.focus(),
                                  );
                                }}
                              >
                                <Reply className="h-3 w-3" strokeWidth={1.5} />
                              </IconButton>
                            )}
                            {isMine &&
                              capabilities?.editMessagesSupported &&
                              !msg.fileReference && (
                                <IconButton
                                  size="xs"
                                  tabIndex={actionTabIndex}
                                  label="Edit message"
                                  onClick={() => {
                                    setReplyTo(null);
                                    setEditingMsg(msg);
                                    setComposerText(msg.message);
                                    requestAnimationFrame(() =>
                                      composerRef.current?.focus(),
                                    );
                                  }}
                                >
                                  <Pencil className="h-3 w-3" strokeWidth={1.5} />
                                </IconButton>
                              )}
                            {isMine &&
                              capabilities?.deleteMessagesSupported &&
                              msg.id !== null && (
                                <InlineDeleteConfirm
                                  armed={confirmDeleteMsgId === msg.id}
                                  tabIndex={actionTabIndex}
                                  onArm={() => setConfirmDeleteMsgId(msg.id)}
                                  onCancel={() => setConfirmDeleteMsgId(null)}
                                  onConfirm={() => {
                                    setConfirmDeleteMsgId(null);
                                    void handleDeleteMessage(msg);
                                  }}
                                  label="Delete message"
                                  iconClassName="h-3 w-3"
                                />
                              )}
                          </div>
                          );
                        })()}
                        </article>
                      </div>
                    );
                  })}
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Compact Anchored Composer Bar (icon-only toggles) */}
            {!selectedRoom.readOnly && (
              <form
                onSubmit={handleSendSubmit}
                className="shrink-0 border-t border-[var(--border-hairline)] bg-[var(--bg-surface)] px-4 py-2.5"
              >
                {(replyTo || editingMsg) && (
                  <div className="mb-2 flex items-center justify-between rounded-md border border-[var(--border-hairline)] bg-[var(--bg-sidebar)] px-2.5 py-1 text-[11px] text-[var(--text-secondary)]">
                    <span className="truncate">
                      {editingMsg
                        ? "Editing message"
                        : `Replying to ${replyTo?.actorDisplayName}: "${replyTo?.message}"`}
                    </span>
                    <IconButton
                      size="xs"
                      label="Cancel reply/edit"
                      onClick={() => {
                        setReplyTo(null);
                        setEditingMsg(null);
                      }}
                    >
                      <X className="h-3 w-3" strokeWidth={1.5} />
                    </IconButton>
                  </div>
                )}

                <input
                  ref={uploadInputRef}
                  type="file"
                  className="hidden"
                  onChange={(e) => void handleFileUploadSelected(e)}
                />

                <div className="flex items-end gap-1.5 rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-2 py-1.5 focus-within:border-[var(--accent)]">
                  {capabilities?.richObjectSharing && (
                    <IconButton
                      size="xs"
                      label="Reference Nextcloud file (zero copy)"
                      onClick={() => void handleOpenFilePicker()}
                    >
                      <Paperclip className="h-3.5 w-3.5" strokeWidth={1.5} />
                    </IconButton>
                  )}
                  {capabilities?.attachmentsAllowed && (
                    <IconButton
                      size="xs"
                      label="Upload & attach file"
                      disabled={uploadingAttachment}
                      onClick={() => uploadInputRef.current?.click()}
                    >
                      {uploadingAttachment ? (
                        <Loader2
                          className="h-3.5 w-3.5 animate-spin"
                          strokeWidth={1.5}
                        />
                      ) : (
                        <Upload className="h-3.5 w-3.5" strokeWidth={1.5} />
                      )}
                    </IconButton>
                  )}

                  <textarea
                    ref={composerRef}
                    rows={1}
                    aria-label={`Message ${selectedRoom.displayName}`}
                    value={composerText}
                    onChange={(e) => {
                      handleComposerChange(e.target.value);
                      e.target.style.height = "auto";
                      e.target.style.height = `${Math.min(e.target.scrollHeight, 128)}px`;
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        if (composerText.trim() && !sending) {
                          e.currentTarget.style.height = "auto";
                          e.currentTarget.form?.requestSubmit();
                        }
                      }
                    }}
                    placeholder={`Message ${selectedRoom.displayName}…`}
                    readOnly={sending}
                    className="max-h-32 min-w-0 flex-1 resize-none bg-transparent px-1 py-0.5 text-[13px] leading-snug text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
                  />

                  <IconButton
                    type="submit"
                    size="xs"
                    label={
                      editingMsg
                        ? "Save edit (Shift+Enter for new line)"
                        : "Send message (Shift+Enter for new line)"
                    }
                    shortcut="Enter"
                    tone={composerText.trim() ? "accent" : "default"}
                    disabled={sending || !composerText.trim()}
                  >
                    {sending ? (
                      <Loader2
                        className="h-3.5 w-3.5 animate-spin"
                        strokeWidth={1.5}
                      />
                    ) : (
                      <ArrowUp className="h-3.5 w-3.5" strokeWidth={1.5} />
                    )}
                  </IconButton>
                </div>
              </form>
            )}
          </>
        )}
      </div>

      {/* Modal: Reference an Existing Nextcloud File */}
      {showFilePicker && (
        <Modal
          ariaLabel="Reference a Nextcloud File"
          onClose={() => setShowFilePicker(false)}
        >
          <div className="flex max-h-[80vh] w-full max-w-xl flex-col overflow-hidden rounded-md border border-[var(--border-strong)] bg-[var(--bg-sidebar)]">
            <div className="flex h-11 items-center justify-between border-b border-[var(--border-hairline)] px-4">
              <div className="flex items-center gap-2">
                <FolderOpen
                  className="h-3.5 w-3.5 text-[var(--accent)]"
                  strokeWidth={1.5}
                />
                <h2 className="text-xs font-medium text-[var(--text-primary)]">
                  Link a Nextcloud File
                </h2>
              </div>
              <IconButton
                size="xs"
                label="Close"
                onClick={() => setShowFilePicker(false)}
              >
                <X className="h-3.5 w-3.5" strokeWidth={1.5} />
              </IconButton>
            </div>

            {error && (
              <div className="border-b border-[var(--border-hairline)] p-3">
                <ErrorBanner error={error} onDismiss={() => setError(null)} />
              </div>
            )}

            <div className="flex flex-wrap items-center gap-1 border-b border-[var(--border-hairline)] bg-[var(--bg-app)] px-3 py-1.5 text-xs">
              <button
                type="button"
                onClick={() => void loadPickerFolder("/")}
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
              >
                <Home className="h-3.5 w-3.5" strokeWidth={1.5} />
                Root
              </button>
              {pickerPath
                .split("/")
                .filter(Boolean)
                .map((seg, idx, arr) => {
                  const target = `/${arr.slice(0, idx + 1).join("/")}`;
                  return (
                    <span key={target} className="inline-flex items-center gap-1">
                      <ChevronRight
                        className="h-3 w-3 text-[var(--text-muted)]"
                        strokeWidth={1.5}
                      />
                      <button
                        type="button"
                        onClick={() => void loadPickerFolder(target)}
                        className="rounded px-1.5 py-0.5 text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                      >
                        {seg}
                      </button>
                    </span>
                  );
                })}
            </div>

            <div className="flex-1 divide-y divide-[var(--border-subtle)] overflow-y-auto">
              {loadingPicker ? (
                <div
                  role="status"
                  aria-live="polite"
                  className="flex items-center justify-center gap-2 p-8 text-xs text-[var(--text-muted)]"
                >
                  <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.5} />
                  Loading folder…
                </div>
              ) : pickerItems.length === 0 ? (
                <div className="p-8 text-center text-xs text-[var(--text-muted)]">
                  This folder is empty.
                </div>
              ) : (
                pickerItems.map((item) => {
                  const isDir = item.entry.kind === "directory";
                  const busy = referencingFileId === item.entry.id;
                  return (
                    <div
                      key={item.entry.path}
                      className="flex items-center justify-between gap-3 px-4 py-2 text-xs hover:bg-[var(--bg-hover)]/60"
                    >
                      <button
                        type="button"
                        onClick={() =>
                          isDir
                            ? void loadPickerFolder(item.entry.path)
                            : void handleReferenceCloudFile(item)
                        }
                        disabled={Boolean(referencingFileId)}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      >
                        {isDir ? (
                          <Folder
                            className="h-4 w-4 shrink-0 text-[var(--text-secondary)]"
                            strokeWidth={1.5}
                          />
                        ) : (
                          <FileIcon
                            className="h-4 w-4 shrink-0 text-[var(--text-muted)]"
                            strokeWidth={1.5}
                          />
                        )}
                        <span className="truncate font-medium text-[var(--text-primary)]">
                          {item.entry.name}
                        </span>
                      </button>

                      {isDir ? (
                        <button
                          type="button"
                          onClick={() => void loadPickerFolder(item.entry.path)}
                          className="inline-flex h-6 items-center gap-1 rounded border border-[var(--border-strong)] px-2 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                        >
                          <Folder className="h-3 w-3" strokeWidth={1.5} />
                          Open
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={Boolean(referencingFileId)}
                          onClick={() => void handleReferenceCloudFile(item)}
                          className="inline-flex h-6 items-center gap-1 rounded bg-[var(--accent)] px-2 text-[11px] font-medium text-white hover:bg-[var(--accent-hover)] disabled:opacity-50"
                        >
                          {busy && (
                            <Loader2
                              className="h-3 w-3 animate-spin"
                              strokeWidth={1.5}
                            />
                          )}
                          Reference
                        </button>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </Modal>
      )}

      {/* Modal: New Conversation */}
      {showNewRoomModal && (
        <Modal
          ariaLabel="New Talk Conversation"
          onClose={() => setShowNewRoomModal(false)}
        >
          <form
            onSubmit={handleCreateRoom}
            className="w-full max-w-md overflow-hidden rounded-md border border-[var(--border-strong)] bg-[var(--bg-sidebar)]"
          >
            <div className="flex h-11 items-center justify-between border-b border-[var(--border-hairline)] px-4">
              <h2 className="text-xs font-medium text-[var(--text-primary)]">
                New Conversation
              </h2>
              <IconButton
                size="xs"
                label="Close"
                onClick={() => setShowNewRoomModal(false)}
              >
                <X className="h-3.5 w-3.5" strokeWidth={1.5} />
              </IconButton>
            </div>
            <div className="space-y-3.5 p-4 text-xs">
              {error && (
                <ErrorBanner error={error} onDismiss={() => setError(null)} />
              )}
              <div className="space-y-1">
                <label
                  htmlFor="talk-room-type"
                  className="block text-[11px] text-[var(--text-secondary)]"
                >
                  Type
                </label>
                <Select
                  id="talk-room-type"
                  ariaLabel="Conversation type"
                  value={newRoomType}
                  onChange={(val) => setNewRoomType(val as TalkRoomType)}
                  options={[
                    { value: "group", label: "Group Channel" },
                    { value: "oneToOne", label: "Direct Message (1:1)" },
                  ]}
                />
              </div>
              {newRoomType === "group" ? (
                <div className="space-y-1">
                  <label
                    htmlFor="talk-room-name"
                    className="block text-[11px] text-[var(--text-secondary)]"
                  >
                    Channel Name *
                  </label>
                  <input
                    id="talk-room-name"
                    type="text"
                    required
                    value={newRoomName}
                    onChange={(e) => setNewRoomName(e.target.value)}
                    placeholder="Aero & Chassis"
                    className="h-8 w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-surface)] px-2.5 text-xs text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
                  />
                </div>
              ) : (
                <div className="space-y-1">
                  <label
                    htmlFor="talk-room-invite"
                    className="block text-[11px] text-[var(--text-secondary)]"
                  >
                    Nextcloud Username *
                  </label>
                  <input
                    id="talk-room-invite"
                    type="text"
                    required
                    value={newRoomInvite}
                    onChange={(e) => setNewRoomInvite(e.target.value)}
                    placeholder="alice"
                    className="h-8 w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-surface)] px-2.5 text-xs text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
                  />
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2 border-t border-[var(--border-hairline)] px-4 py-3">
              <button
                type="button"
                onClick={() => setShowNewRoomModal(false)}
                className="h-8 rounded-md border border-[var(--border-strong)] px-3 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={creatingRoom}
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[var(--accent)] px-3.5 text-xs font-medium text-white hover:bg-[var(--accent-hover)] disabled:opacity-50"
              >
                {creatingRoom && (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.5} />
                )}
                Create
              </button>
            </div>
          </form>
        </Modal>
      )}
    </WorkspaceLayout>
  );
}
