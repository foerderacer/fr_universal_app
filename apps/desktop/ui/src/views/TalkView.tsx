import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  CheckCircle2,
  ChevronRight,
  ExternalLink,
  File as FileIcon,
  Folder,
  FolderOpen,
  Home,
  Loader2,
  MessageSquare,
  Paperclip,
  Pencil,
  Plus,
  RefreshCw,
  Reply,
  Search,
  Send,
  Star,
  Trash2,
  Upload,
  Users,
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
}

interface TalkMessagesEventPayload {
  token: string;
  messages: TalkMessage_Serialize[];
  lastGiven: number | null;
}

const QUICK_REACTIONS = ["👍", "❤️", "🎉", "👀"];
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
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function TalkView({
  isNextcloudConnected,
  currentActorId,
}: TalkViewProps) {
  const [capabilities, setCapabilities] = useState<TalkCapabilities | null>(
    null,
  );
  const [rooms, setRooms] = useState<TalkRoom_Serialize[]>([]);
  const [roomsFromCache, setRoomsFromCache] = useState(false);
  const [loadingRooms, setLoadingRooms] = useState(true);
  const [roomSearch, setRoomSearch] = useState("");

  const [selectedToken, setSelectedToken] = useState<string | null>(null);
  const [messages, setMessages] = useState<TalkMessage_Serialize[]>([]);
  const [messagesFromCache, setMessagesFromCache] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasOlder, setHasOlder] = useState(true);

  const [composerText, setComposerText] = useState("");
  const [replyTo, setReplyTo] = useState<TalkMessage_Serialize | null>(null);
  const [editingMsg, setEditingMsg] = useState<TalkMessage_Serialize | null>(
    null,
  );
  const [sending, setSending] = useState(false);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const [uploadingAttachment, setUploadingAttachment] = useState(false);

  const [showNewRoomModal, setShowNewRoomModal] = useState(false);
  const [newRoomType, setNewRoomType] = useState<TalkRoomType>("group");
  const [newRoomName, setNewRoomName] = useState("");
  const [newRoomInvite, setNewRoomInvite] = useState("");
  const [creatingRoom, setCreatingRoom] = useState(false);

  // Flow A2: inline Nextcloud file picker for zero-copy file-ID references
  const [showFilePicker, setShowFilePicker] = useState(false);
  const [pickerPath, setPickerPath] = useState("/");
  const [pickerItems, setPickerItems] = useState<FileItemView_Serialize[]>([]);
  const [loadingPicker, setLoadingPicker] = useState(false);
  const [referencingFileId, setReferencingFileId] = useState<string | null>(
    null,
  );

  // Flow C: open clicked file reference directly inside our FilePreviewPane
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
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const draftTimersRef = useRef<Map<string, number>>(new Map());
  const pendingDraftsRef = useRef<Map<string, string>>(new Map());
  const userTypedInRoomRef = useRef<Set<string>>(new Set());
  const lastScrolledTokenRef = useRef<string | null>(null);
  const lastMessageIdRef = useRef<number>(0);
  const selectedTokenRef = useRef<string | null>(null);
  selectedTokenRef.current = selectedToken;

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

  const cancelPendingDraft = useCallback((token: string) => {
    const timer = draftTimersRef.current.get(token);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      draftTimersRef.current.delete(token);
    }
    pendingDraftsRef.current.delete(token);
  }, []);

  // Flush any queued drafts on unmount so edits are never silently lost.
  useEffect(() => {
    const pendingDrafts = pendingDraftsRef.current;
    return () => {
      for (const token of Array.from(pendingDrafts.keys())) {
        flushDraft(token);
      }
    };
  }, [flushDraft]);

  // Dismiss modals with Escape key.
  useEffect(() => {
    if (!showFilePicker && !showNewRoomModal) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setShowFilePicker(false);
        setShowNewRoomModal(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [showFilePicker, showNewRoomModal]);

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
    // Re-sync rooms whenever connection state or the signed-in Nextcloud account changes.
    if (currentActorId === null && !isNextcloudConnected) {
      setSelectedToken(null);
    }
    void loadRoomsAndCaps();
  }, [loadRoomsAndCaps, currentActorId, isNextcloudConnected]);

  // Listen to Rust long-poll message push events.
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

  // Load selected room history, restore draft, and start Rust long-poll ONLY for this room.
  useEffect(() => {
    if (!isNextcloudConnected || !selectedToken) {
      void stopTalkPolling().catch(() => {});
      return;
    }
    let cancelled = false;
    const token = selectedToken;
    userTypedInRoomRef.current.delete(token);
    setLoadingMessages(true);
    setMessages([]);
    setMessagesFromCache(false);
    setPreviewItem(null);
    setPreviewFileRef(null);
    setPreviewExpanded(false);
    setAccessDeniedFile(null);
    setReplyTo(null);
    setEditingMsg(null);
    setAttachMenuOpen(false);
    setHasOlder(true);
    setComposerText(pendingDraftsRef.current.get(token) ?? "");

    void Promise.all([
      getTalkMessages(token, null, 50),
      getTalkDraft(token).catch(() => null),
    ])
      .then(async ([page, draft]) => {
        if (cancelled || selectedTokenRef.current !== token) return;
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
        if (!page.fromCache && !cancelled && selectedTokenRef.current === token) {
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

  // Auto-scroll to bottom only on initial room load or when newer messages arrive,
  // never when prepending older history via "Load older messages".
  useEffect(() => {
    const newestId =
      messages.length > 0 ? (messages[messages.length - 1]?.id ?? 0) : 0;
    const switchedRoom = lastScrolledTokenRef.current !== selectedToken;
    if (switchedRoom) {
      lastScrolledTokenRef.current = selectedToken;
      lastMessageIdRef.current = newestId;
      if (messages.length > 0) {
        messagesEndRef.current?.scrollIntoView({ behavior: "auto" });
      }
      return;
    }
    if (newestId > lastMessageIdRef.current) {
      lastMessageIdRef.current = newestId;
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, selectedToken]);

  // Per-room debounced local draft save so switching rooms never cancels or loses edits.
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
      if (selectedTokenRef.current === token) {
        setLoadingOlder(false);
      }
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
      cancelPendingDraft(token);
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

  // Flow A2: browse Nextcloud files to reference without copying
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
    setAttachMenuOpen(false);
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
      flashNotice(`Referenced "${item.entry.name}" in chat (zero file copies).`);
    } catch (err) {
      if (selectedTokenRef.current === token) {
        setError(toUserFacingError(err));
      }
    } finally {
      setReferencingFileId(null);
    }
  }

  // Flow B: upload a new file once to the Talk attachments folder and attach
  async function handleFileUploadSelected(
    event: React.ChangeEvent<HTMLInputElement>,
  ) {
    const file = event.target.files?.[0];
    event.target.value = "";
    const room = selectedRoom;
    if (!file || !room) return;
    const token = room.token;
    setAttachMenuOpen(false);
    if (file.size > MAX_TALK_UPLOAD_BYTES) {
      setError({
        code: "invalid_input",
        title: "File is too large for Talk chat",
        message: `"${file.name}" is ${formatBytes(file.size)}, which exceeds the 50 MB chat attachment limit.`,
        recoveryHint:
          "Upload larger files in Nextcloud Files first, then use 'Reference from Nextcloud Files' to link them with zero copies.",
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

  // Flow C: open clicked file reference directly in our Files preview pane
  function handleOpenFileReference(fileRef: TalkFileReference_Serialize) {
    setAccessDeniedFile(null);
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

  const filteredRooms = useMemo(() => {
    const q = roomSearch.trim().toLowerCase();
    if (!q) return rooms;
    return rooms.filter(
      (r) =>
        r.displayName.toLowerCase().includes(q) ||
        r.description.toLowerCase().includes(q),
    );
  }, [rooms, roomSearch]);

  if (!isNextcloudConnected) {
    return (
      <div className="mx-auto max-w-xl rounded-2xl border border-slate-200 bg-white p-10 text-center shadow-xs dark:border-slate-800 dark:bg-slate-900">
        <MessageSquare className="mx-auto h-10 w-10 text-blue-500" />
        <h2 className="mt-3 text-base font-semibold text-slate-900 dark:text-slate-100">
          Sign in to Nextcloud to open Talk
        </h2>
        <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
          FR Universal App connects directly to your team&apos;s Nextcloud Talk
          conversations and lets you reference cloud files without copying them.
        </p>
      </div>
    );
  }

  if (capabilities && !capabilities.enabled) {
    return (
      <div className="mx-auto max-w-xl rounded-2xl border border-slate-200 bg-white p-10 text-center shadow-xs dark:border-slate-800 dark:bg-slate-900">
        <MessageSquare className="mx-auto h-10 w-10 text-slate-400" />
        <h2 className="mt-3 text-base font-semibold text-slate-900 dark:text-slate-100">
          Nextcloud Talk isn&apos;t enabled on this server
        </h2>
        <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
          Ask your Nextcloud administrator to enable the official{" "}
          <strong>Nextcloud Talk (spreed)</strong> app, then click refresh.
        </p>
        <button
          type="button"
          onClick={() => void loadRoomsAndCaps()}
          className="mt-4 inline-flex items-center gap-1.5 rounded-xl bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-700"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Check again
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-[calc(100vh-8.5rem)] max-w-7xl flex-col gap-3">
      {error && <ErrorBanner error={error} onDismiss={() => setError(null)} />}
      {notice && (
        <div className="flex items-center justify-between rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2 text-xs font-medium text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300">
          <span className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            {notice}
          </span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            className="hover:underline"
          >
            Dismiss
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1 gap-4 overflow-hidden">
        {/* Left: Conversation List */}
        <aside className="flex w-72 shrink-0 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xs dark:border-slate-800 dark:bg-slate-900">
          <div className="flex items-center justify-between border-b border-slate-200 px-3.5 py-3 dark:border-slate-800">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                Conversations
              </span>
              {roomsFromCache && (
                <span
                  title="Showing cached conversations while offline"
                  className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:bg-amber-950/60 dark:text-amber-300"
                >
                  <WifiOff className="h-3 w-3" />
                  Offline
                </span>
              )}
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => void loadRoomsAndCaps()}
                disabled={loadingRooms}
                title="Refresh conversations"
                className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 ${loadingRooms ? "animate-spin" : ""}`}
                />
              </button>
              <button
                type="button"
                onClick={() => setShowNewRoomModal(true)}
                title="New conversation"
                className="rounded-lg bg-blue-600 p-1.5 text-white hover:bg-blue-700"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          <div className="border-b border-slate-100 p-2.5 dark:border-slate-800">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={roomSearch}
                onChange={(e) => setRoomSearch(e.target.value)}
                placeholder="Filter chats..."
                className="w-full rounded-lg border border-slate-200 bg-slate-50 py-1.5 pr-2.5 pl-8 text-xs dark:border-slate-700 dark:bg-slate-950"
              />
            </div>
          </div>

          <div className="flex-1 divide-y divide-slate-100 overflow-y-auto dark:divide-slate-800/70">
            {loadingRooms ? (
              <div className="p-6 text-center text-xs text-slate-400">
                Loading conversations...
              </div>
            ) : filteredRooms.length === 0 ? (
              <div className="p-6 text-center text-xs text-slate-400">
                No conversations found.
              </div>
            ) : (
              filteredRooms.map((room) => {
                const active = room.token === selectedToken;
                return (
                  <div
                    key={room.token}
                    onClick={() => setSelectedToken(room.token)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        setSelectedToken(room.token);
                      }
                    }}
                    className={`flex cursor-pointer items-start gap-2.5 px-3.5 py-3 transition-colors ${
                      active
                        ? "bg-blue-50/90 dark:bg-blue-950/40"
                        : "hover:bg-slate-50 dark:hover:bg-slate-800/60"
                    }`}
                  >
                    <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                      {room.roomType === "group" ||
                      room.roomType === "public" ? (
                        <Users className="h-4 w-4" />
                      ) : (
                        <MessageSquare className="h-4 w-4" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-1.5">
                        <p className="truncate text-xs font-semibold text-slate-900 dark:text-slate-100">
                          {room.displayName}
                        </p>
                        <div className="flex shrink-0 items-center gap-1">
                          {room.unreadMessages > 0 && (
                            <span className="rounded-full bg-blue-600 px-1.5 py-0.5 text-[10px] font-bold text-white">
                              {room.unreadMessages}
                            </span>
                          )}
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              void handleToggleFavorite(room);
                            }}
                            title={
                              room.isFavorite
                                ? "Remove favorite"
                                : "Pin favorite"
                            }
                            className="text-slate-400 hover:text-amber-500"
                          >
                            <Star
                              className={`h-3.5 w-3.5 ${
                                room.isFavorite
                                  ? "fill-amber-400 text-amber-400"
                                  : ""
                              }`}
                            />
                          </button>
                        </div>
                      </div>
                      {room.lastMessagePreview && (
                        <p className="mt-0.5 truncate text-[11px] text-slate-500 dark:text-slate-400">
                          {room.lastMessageActor
                            ? `${room.lastMessageActor}: `
                            : ""}
                          {room.lastMessagePreview}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </aside>

        {/* Center: Message Timeline & Composer */}
        <section className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xs dark:border-slate-800 dark:bg-slate-900">
          {!selectedRoom ? (
            <div className="flex flex-1 flex-col items-center justify-center p-8 text-center text-xs text-slate-400">
              <MessageSquare className="h-9 w-9 text-slate-300 dark:text-slate-700" />
              <p className="mt-2">Select a conversation to start chatting.</p>
            </div>
          ) : (
            <>
              {/* Room Header */}
              <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-800">
                <div className="min-w-0">
                  <h2 className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
                    {selectedRoom.displayName}
                  </h2>
                  {selectedRoom.description && (
                    <p className="truncate text-[11px] text-slate-500 dark:text-slate-400">
                      {selectedRoom.description}
                    </p>
                  )}
                </div>
                {messagesFromCache && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2.5 py-1 text-[11px] font-medium text-amber-700 dark:bg-amber-950/50 dark:text-amber-300">
                    <WifiOff className="h-3 w-3" />
                    Cached history
                  </span>
                )}
              </div>

              {/* Access-denied notice when recipient clicks a file reference they lack permission for */}
              {accessDeniedFile && (
                <div className="border-b border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
                  <div className="flex items-center justify-between gap-2">
                    <span>
                      <strong>{accessDeniedFile.name}</strong> couldn&apos;t be
                      opened directly in Files — your Nextcloud account may not
                      have access to its folder.
                    </span>
                    <div className="flex shrink-0 items-center gap-2">
                      {accessDeniedFile.link && (
                        <button
                          type="button"
                          onClick={() =>
                            void openExternalUrl(accessDeniedFile.link!)
                          }
                          className="inline-flex items-center gap-1 font-semibold underline"
                        >
                          Open in Nextcloud
                          <ExternalLink className="h-3 w-3" />
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setAccessDeniedFile(null)}
                        className="rounded p-0.5 hover:bg-amber-200/50"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* Message Feed */}
              <div className="flex-1 space-y-3 overflow-y-auto p-4">
                {hasOlder && messages.length > 0 && !messagesFromCache && (
                  <div className="text-center">
                    <button
                      type="button"
                      disabled={loadingOlder}
                      onClick={() => void handleLoadOlder()}
                      className="rounded-lg border border-slate-200 px-3 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                    >
                      {loadingOlder
                        ? "Loading older messages..."
                        : "Load older messages"}
                    </button>
                  </div>
                )}

                {loadingMessages ? (
                  <div className="flex items-center justify-center gap-2 py-12 text-xs text-slate-400">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading messages...
                  </div>
                ) : messages.length === 0 ? (
                  <p className="py-12 text-center text-xs text-slate-400">
                    No messages yet. Say hello or click <strong>+</strong> to
                    reference a Nextcloud file.
                  </p>
                ) : (
                  messages.map((msg) => {
                    const isMine =
                      Boolean(currentActorId) &&
                      msg.actorId === currentActorId;
                    const isSystem = msg.messageType === "system";
                    if (isSystem) {
                      return (
                        <div
                          key={msg.id ?? msg.referenceId}
                          className="text-center text-[11px] text-slate-400"
                        >
                          {msg.actorDisplayName} · {msg.message}
                        </div>
                      );
                    }

                    return (
                      <div
                        key={msg.id ?? msg.referenceId}
                        className={`group flex flex-col ${isMine ? "items-end" : "items-start"}`}
                      >
                        <div className="mb-0.5 flex items-center gap-2 px-1 text-[11px] text-slate-400">
                          <span className="font-medium text-slate-600 dark:text-slate-300">
                            {msg.actorDisplayName}
                          </span>
                          <span>{formatMessageTime(msg.timestamp)}</span>
                        </div>

                        <div
                          className={`max-w-[82%] rounded-2xl px-3.5 py-2.5 text-xs shadow-2xs ${
                            isMine
                              ? "bg-blue-600 text-white"
                              : "border border-slate-200 bg-slate-50 text-slate-900 dark:border-slate-800 dark:bg-slate-950/70 dark:text-slate-100"
                          }`}
                        >
                          {msg.parent && (
                            <div
                              className={`mb-1.5 rounded-lg border-l-2 px-2 py-1 text-[11px] ${
                                isMine
                                  ? "border-blue-300 bg-blue-700/60 text-blue-100"
                                  : "border-slate-300 bg-slate-100 text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400"
                              }`}
                            >
                              <span className="font-semibold">
                                {msg.parent.actorDisplayName}:
                              </span>{" "}
                              <span className="line-clamp-2">
                                {msg.parent.deleted
                                  ? "Message deleted"
                                  : msg.parent.message}
                              </span>
                            </div>
                          )}

                          {msg.deleted ? (
                            <p className="italic opacity-75">Message deleted</p>
                          ) : (
                            <>
                              {msg.fileReference && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    handleOpenFileReference(msg.fileReference!)
                                  }
                                  className={`mb-1.5 flex w-full items-center gap-2.5 rounded-xl border p-2.5 text-left transition-colors ${
                                    isMine
                                      ? "border-blue-400/50 bg-blue-700/60 text-white hover:bg-blue-700"
                                      : "border-slate-200 bg-white text-slate-900 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800"
                                  }`}
                                >
                                  <FileIcon className="h-5 w-5 shrink-0 opacity-80" />
                                  <div className="min-w-0 flex-1">
                                    <p className="truncate font-semibold">
                                      {msg.fileReference.name}
                                    </p>
                                    <p className="truncate text-[10px] opacity-80">
                                      {msg.fileReference.path ??
                                        `Cloud file #${msg.fileReference.fileId}`}
                                      {msg.fileReference.size
                                        ? ` · ${formatBytes(msg.fileReference.size)}`
                                        : ""}
                                    </p>
                                  </div>
                                  <span className="shrink-0 rounded-md bg-black/10 px-2 py-0.5 text-[10px] font-semibold">
                                    Preview
                                  </span>
                                </button>
                              )}

                              {(!msg.fileReference ||
                                msg.message !== msg.fileReference.name) && (
                                <p className="break-words whitespace-pre-wrap">
                                  {msg.message}
                                </p>
                              )}
                            </>
                          )}
                        </div>

                        {/* Reactions + Hover Actions */}
                        {!msg.deleted && (
                          <div className="mt-1 flex flex-wrap items-center gap-1 px-1">
                            {Object.entries(msg.reactions).map(
                              ([emoji, count]) => (
                                <button
                                  key={emoji}
                                  type="button"
                                  disabled={!capabilities?.reactionsSupported}
                                  onClick={() =>
                                    void handleToggleReaction(msg, emoji)
                                  }
                                  className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${
                                    msg.reactionsSelf.includes(emoji)
                                      ? "border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-700 dark:bg-blue-950/60 dark:text-blue-300"
                                      : "border-slate-200 bg-white text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"
                                  }`}
                                >
                                  <span>{emoji}</span>
                                  <span>{count}</span>
                                </button>
                              ),
                            )}

                            <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                              {capabilities?.reactionsSupported &&
                                QUICK_REACTIONS.map((emoji) => (
                                  <button
                                    key={emoji}
                                    type="button"
                                    onClick={() =>
                                      void handleToggleReaction(msg, emoji)
                                    }
                                    className="rounded px-1 text-[11px] hover:bg-slate-100 dark:hover:bg-slate-800"
                                  >
                                    {emoji}
                                  </button>
                                ))}
                              {msg.isReplyable && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setEditingMsg(null);
                                    setReplyTo(msg);
                                  }}
                                  title="Reply"
                                  className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800"
                                >
                                  <Reply className="h-3 w-3" />
                                </button>
                              )}
                              {isMine &&
                                capabilities?.editMessagesSupported &&
                                !msg.fileReference && (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setReplyTo(null);
                                      setEditingMsg(msg);
                                      setComposerText(msg.message);
                                    }}
                                    title="Edit message"
                                    className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800"
                                  >
                                    <Pencil className="h-3 w-3" />
                                  </button>
                                )}
                              {isMine &&
                                capabilities?.deleteMessagesSupported && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      void handleDeleteMessage(msg)
                                    }
                                    title="Delete message"
                                    className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950/40"
                                  >
                                    <Trash2 className="h-3 w-3" />
                                  </button>
                                )}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
                <div ref={messagesEndRef} />
              </div>

              {/* Composer */}
              {!selectedRoom.readOnly && (
                <form
                  onSubmit={handleSendSubmit}
                  className="relative border-t border-slate-200 p-3 dark:border-slate-800"
                >
                  {(replyTo || editingMsg) && (
                    <div className="mb-2 flex items-center justify-between rounded-lg bg-slate-100 px-3 py-1.5 text-[11px] text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                      <span className="truncate">
                        {editingMsg
                          ? "Editing your message"
                          : `Replying to ${replyTo?.actorDisplayName}: "${replyTo?.message}"`}
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          setReplyTo(null);
                          setEditingMsg(null);
                        }}
                        className="ml-2 text-slate-400 hover:text-slate-700"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )}

                  {/* "+" Attachment Popover Menu */}
                  {attachMenuOpen && (
                    <div className="absolute bottom-16 left-3 z-20 w-72 rounded-xl border border-slate-200 bg-white p-1.5 shadow-lg dark:border-slate-700 dark:bg-slate-900">
                      {capabilities?.richObjectSharing && (
                        <button
                          type="button"
                          onClick={() => void handleOpenFilePicker()}
                          className="flex w-full items-start gap-2.5 rounded-lg px-3 py-2 text-left text-xs hover:bg-slate-100 dark:hover:bg-slate-800"
                        >
                          <FolderOpen className="mt-0.5 h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400" />
                          <div>
                            <p className="font-semibold text-slate-900 dark:text-slate-100">
                              Reference from Nextcloud Files
                            </p>
                            <p className="text-[11px] text-slate-500 dark:text-slate-400">
                              Link an existing cloud file — zero copies made.
                            </p>
                          </div>
                        </button>
                      )}
                      {capabilities?.attachmentsAllowed && (
                        <button
                          type="button"
                          onClick={() => uploadInputRef.current?.click()}
                          className="flex w-full items-start gap-2.5 rounded-lg px-3 py-2 text-left text-xs hover:bg-slate-100 dark:hover:bg-slate-800"
                        >
                          <Upload className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                          <div>
                            <p className="font-semibold text-slate-900 dark:text-slate-100">
                              Upload &amp; attach new file
                            </p>
                            <p className="text-[11px] text-slate-500 dark:text-slate-400">
                              Stores once in{" "}
                              <code>{capabilities.attachmentsFolder}</code>.
                            </p>
                          </div>
                        </button>
                      )}
                      {!capabilities?.richObjectSharing &&
                        !capabilities?.attachmentsAllowed && (
                          <p className="px-3 py-2 text-[11px] text-slate-500">
                            File attachments are disabled on this Nextcloud
                            server.
                          </p>
                        )}
                    </div>
                  )}

                  <input
                    ref={uploadInputRef}
                    type="file"
                    className="hidden"
                    onChange={(e) => void handleFileUploadSelected(e)}
                  />

                  <div className="flex items-end gap-2">
                    <button
                      type="button"
                      disabled={uploadingAttachment}
                      onClick={() => setAttachMenuOpen((prev) => !prev)}
                      title="Reference a Nextcloud file or upload an attachment"
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200 dark:hover:bg-slate-800"
                    >
                      {uploadingAttachment ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Plus className="h-4 w-4" />
                      )}
                    </button>

                    <input
                      type="text"
                      value={composerText}
                      onChange={(e) => handleComposerChange(e.target.value)}
                      placeholder={`Message ${selectedRoom.displayName}...`}
                      disabled={sending}
                      className="flex-1 rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                    />

                    <button
                      type="submit"
                      disabled={sending || !composerText.trim()}
                      className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl bg-blue-600 px-3.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                    >
                      {sending ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Send className="h-3.5 w-3.5" />
                      )}
                      {editingMsg ? "Save" : "Send"}
                    </button>
                  </div>
                </form>
              )}
            </>
          )}
        </section>

        {/* Right: Inline Preview Pane for Clicked File References (Flow C) */}
        {previewItem && (
          <div
            className={
              previewExpanded
                ? "fixed inset-4 z-40 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-slate-800 dark:bg-slate-900"
                : "w-full shrink-0 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xs lg:w-[440px] dark:border-slate-800 dark:bg-slate-900"
            }
          >
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
              onPreviewError={(previewErr) => {
                if (
                  previewFileRef &&
                  (previewErr.code === "auth_required" ||
                    previewErr.code === "not_found" ||
                    previewErr.code === "permission_denied")
                ) {
                  setAccessDeniedFile(previewFileRef);
                  setPreviewItem(null);
                  setPreviewFileRef(null);
                  setPreviewExpanded(false);
                }
              }}
            />
          </div>
        )}
      </div>

      {/* Modal: Reference an Existing Nextcloud File (Flow A2 — Zero Copies) */}
      {showFilePicker && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Reference a Nextcloud File"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4 backdrop-blur-xs"
        >
          <div className="flex max-h-[82vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl dark:border-slate-800 dark:bg-slate-900">
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5 dark:border-slate-800">
              <div>
                <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
                  <Paperclip className="h-4 w-4 text-blue-600" />
                  Reference a Nextcloud File
                </h2>
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  Links directly to the original file — no copy or permission
                  change is created.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowFilePicker(false)}
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {error && (
              <div className="border-b border-slate-100 px-4 py-2.5 dark:border-slate-800">
                <ErrorBanner error={error} onDismiss={() => setError(null)} />
              </div>
            )}

            {/* Breadcrumbs */}
            <div className="flex flex-wrap items-center gap-1 border-b border-slate-100 bg-slate-50 px-4 py-2 text-xs dark:border-slate-800 dark:bg-slate-950/60">
              <button
                type="button"
                onClick={() => void loadPickerFolder("/")}
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium text-slate-600 hover:bg-slate-200/70 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                <Home className="h-3.5 w-3.5" />
                Root
              </button>
              {pickerPath
                .split("/")
                .filter(Boolean)
                .map((seg, idx, arr) => {
                  const target = `/${arr.slice(0, idx + 1).join("/")}`;
                  return (
                    <span key={target} className="inline-flex items-center gap-1">
                      <ChevronRight className="h-3 w-3 text-slate-400" />
                      <button
                        type="button"
                        onClick={() => void loadPickerFolder(target)}
                        className="rounded px-1.5 py-0.5 font-medium text-slate-700 hover:bg-slate-200/70 dark:text-slate-200 dark:hover:bg-slate-800"
                      >
                        {seg}
                      </button>
                    </span>
                  );
                })}
            </div>

            <div className="flex-1 divide-y divide-slate-100 overflow-y-auto dark:divide-slate-800">
              {loadingPicker ? (
                <div className="flex items-center justify-center gap-2 p-8 text-xs text-slate-400">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading folder...
                </div>
              ) : pickerItems.length === 0 ? (
                <div className="p-8 text-center text-xs text-slate-400">
                  This folder is empty.
                </div>
              ) : (
                pickerItems.map((item) => {
                  const isDir = item.entry.kind === "directory";
                  const busy = referencingFileId === item.entry.id;
                  return (
                    <div
                      key={item.entry.path}
                      className="flex items-center justify-between gap-3 px-4 py-2.5 text-xs hover:bg-slate-50 dark:hover:bg-slate-800/50"
                    >
                      <button
                        type="button"
                        onClick={() =>
                          isDir
                            ? void loadPickerFolder(item.entry.path)
                            : void handleReferenceCloudFile(item)
                        }
                        disabled={Boolean(referencingFileId)}
                        className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                      >
                        {isDir ? (
                          <Folder className="h-4 w-4 shrink-0 text-blue-500" />
                        ) : (
                          <FileIcon className="h-4 w-4 shrink-0 text-slate-400" />
                        )}
                        <span className="truncate font-medium text-slate-800 dark:text-slate-200">
                          {item.entry.name}
                        </span>
                      </button>

                      {isDir ? (
                        <button
                          type="button"
                          onClick={() => void loadPickerFolder(item.entry.path)}
                          className="rounded-lg border border-slate-200 px-2.5 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300"
                        >
                          Open
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={Boolean(referencingFileId)}
                          onClick={() => void handleReferenceCloudFile(item)}
                          className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                        >
                          {busy && (
                            <Loader2 className="h-3 w-3 animate-spin" />
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
        </div>
      )}

      {/* Modal: New Conversation */}
      {showNewRoomModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="New Talk Conversation"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4 backdrop-blur-xs"
        >
          <form
            onSubmit={handleCreateRoom}
            className="w-full max-w-md overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl dark:border-slate-800 dark:bg-slate-900"
          >
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5 dark:border-slate-800">
              <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                New Talk Conversation
              </h2>
              <button
                type="button"
                onClick={() => setShowNewRoomModal(false)}
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-4 p-5 text-xs">
              {error && (
                <ErrorBanner error={error} onDismiss={() => setError(null)} />
              )}
              <div className="space-y-1.5">
                <label className="block font-medium text-slate-700 dark:text-slate-300">
                  Conversation Type
                </label>
                <select
                  value={newRoomType}
                  onChange={(e) =>
                    setNewRoomType(e.target.value as TalkRoomType)
                  }
                  className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-950"
                >
                  <option value="group">Group Chat</option>
                  <option value="oneToOne">Direct Message (1:1)</option>
                </select>
              </div>
              {newRoomType === "group" ? (
                <div className="space-y-1.5">
                  <label className="block font-medium text-slate-700 dark:text-slate-300">
                    Group Name *
                  </label>
                  <input
                    type="text"
                    required
                    value={newRoomName}
                    onChange={(e) => setNewRoomName(e.target.value)}
                    placeholder="Aero & Chassis Team"
                    className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
                  />
                </div>
              ) : (
                <div className="space-y-1.5">
                  <label className="block font-medium text-slate-700 dark:text-slate-300">
                    Teammate Nextcloud Username *
                  </label>
                  <input
                    type="text"
                    required
                    value={newRoomInvite}
                    onChange={(e) => setNewRoomInvite(e.target.value)}
                    placeholder="alice"
                    className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
                  />
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-3 dark:border-slate-800">
              <button
                type="button"
                onClick={() => setShowNewRoomModal(false)}
                className="rounded-xl border border-slate-300 px-3.5 py-2 text-xs font-medium text-slate-700 dark:border-slate-700 dark:text-slate-300"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={creatingRoom}
                className="inline-flex items-center gap-1.5 rounded-xl bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {creatingRoom && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Create
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
