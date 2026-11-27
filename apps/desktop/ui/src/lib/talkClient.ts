import { isTauri } from "@tauri-apps/api/core";
import {
  commands,
  type CreateTalkRoomRequest_Deserialize,
  type SendTalkMessageRequest_Deserialize,
  type TalkCapabilities,
  type TalkMessage_Serialize,
  type TalkMessagesPage_Serialize,
  type TalkRoom_Serialize,
  type TalkRoomsPage_Serialize,
} from "../bindings/tauri";

import {
  PREVIEW_TALK_CAPS,
  PREVIEW_TALK_MESSAGES,
  PREVIEW_TALK_ROOMS,
} from "./previewFixtures";

function requireDesktop(action: string): never {
  throw {
    code: "browser_preview",
    title: "Desktop app required",
    message: `${action} is available inside the FR Universal App desktop window.`,
    recoveryHint: "Launch FR Universal App via Tauri.",
    technicalDetails: null,
  };
}

export async function getTalkCapabilities(): Promise<TalkCapabilities> {
  if (!isTauri()) {
    return PREVIEW_TALK_CAPS;
  }
  return commands.getTalkCapabilities();
}

export async function listTalkRooms(
  modifiedSince: number | null = null,
): Promise<TalkRoomsPage_Serialize> {
  if (!isTauri()) {
    return { rooms: PREVIEW_TALK_ROOMS, modifiedBefore: null, fromCache: false };
  }
  return commands.listTalkRooms(modifiedSince);
}

export async function createTalkRoom(
  input: CreateTalkRoomRequest_Deserialize,
): Promise<TalkRoom_Serialize> {
  if (!isTauri()) requireDesktop("Creating Talk conversations");
  return commands.createTalkRoom(input);
}

export async function toggleTalkRoomFavorite(
  token: string,
  favorite: boolean,
): Promise<void> {
  if (!isTauri()) requireDesktop("Updating Talk favorites");
  await commands.toggleTalkRoomFavorite(token, favorite);
}

export async function leaveTalkRoom(token: string): Promise<void> {
  if (!isTauri()) requireDesktop("Leaving Talk conversations");
  await commands.leaveTalkRoom(token);
}

export async function getTalkMessages(
  token: string,
  beforeMessageId: number | null = null,
  limit = 50,
): Promise<TalkMessagesPage_Serialize> {
  if (!isTauri()) {
    const msgs = PREVIEW_TALK_MESSAGES[token] ?? [];
    return {
      messages: beforeMessageId ? [] : msgs,
      lastGiven: msgs[msgs.length - 1]?.id ?? null,
      lastCommonRead: null,
      fromCache: false,
    };
  }
  return commands.getTalkMessages(token, beforeMessageId, limit);
}

export async function sendTalkMessage(
  input: SendTalkMessageRequest_Deserialize,
): Promise<TalkMessage_Serialize> {
  if (!isTauri()) requireDesktop("Sending Talk messages");
  return commands.sendTalkMessage(input);
}

export async function editTalkMessage(
  token: string,
  messageId: number,
  message: string,
): Promise<TalkMessage_Serialize> {
  if (!isTauri()) requireDesktop("Editing Talk messages");
  return commands.editTalkMessage(token, messageId, message);
}

export async function deleteTalkMessage(
  token: string,
  messageId: number,
): Promise<TalkMessage_Serialize> {
  if (!isTauri()) requireDesktop("Deleting Talk messages");
  return commands.deleteTalkMessage(token, messageId);
}

export async function markTalkRead(
  token: string,
  lastReadMessageId: number,
): Promise<void> {
  if (!isTauri()) return;
  await commands.markTalkRead(token, lastReadMessageId);
}

export async function toggleTalkReaction(
  token: string,
  messageId: number,
  reaction: string,
  add: boolean,
): Promise<void> {
  if (!isTauri()) requireDesktop("Reacting to Talk messages");
  await commands.toggleTalkReaction(token, messageId, reaction, add);
}

export async function shareTalkFileReference(
  token: string,
  fileId: string,
): Promise<TalkMessage_Serialize> {
  if (!isTauri()) requireDesktop("Referencing Nextcloud files in Talk");
  return commands.shareTalkFileReference(token, fileId);
}

export async function uploadTalkAttachmentBytes(
  token: string,
  roomDisplayName: string,
  fileName: string,
  bytes: Uint8Array,
): Promise<string> {
  if (!isTauri()) requireDesktop("Uploading Talk attachments");
  const base64 = uint8ToBase64(bytes);
  return commands.uploadTalkAttachmentBase64(
    token,
    roomDisplayName,
    fileName,
    base64,
  );
}

const PREVIEW_TALK_DRAFT_PREFIX = "fr.preview.talkDraft.v1:";

export async function getTalkDraft(token: string): Promise<string | null> {
  if (!isTauri()) {
    try {
      return window.localStorage.getItem(`${PREVIEW_TALK_DRAFT_PREFIX}${token}`);
    } catch {
      return null;
    }
  }
  return commands.getTalkDraft(token);
}

export async function saveTalkDraft(
  token: string,
  text: string,
): Promise<void> {
  if (!isTauri()) {
    try {
      const key = `${PREVIEW_TALK_DRAFT_PREFIX}${token}`;
      if (text) {
        window.localStorage.setItem(key, text);
      } else {
        window.localStorage.removeItem(key);
      }
    } catch {
      // Ignore storage access errors in restricted previews.
    }
    return;
  }
  await commands.saveTalkDraft(token, text);
}

export async function startTalkPolling(
  token: string,
  lastKnownMessageId: number | null,
): Promise<void> {
  if (!isTauri()) return;
  await commands.startTalkPolling(token, lastKnownMessageId);
}

export async function stopTalkPolling(): Promise<void> {
  if (!isTauri()) return;
  await commands.stopTalkPolling();
}

function uint8ToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}
