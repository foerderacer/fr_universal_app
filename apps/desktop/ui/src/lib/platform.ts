export const IS_MAC_PLATFORM =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad|iPod/i.test(
    (navigator as Navigator & { userAgentData?: { platform?: string } })
      .userAgentData?.platform ?? navigator.userAgent,
  );

export const MOD_KEY = IS_MAC_PLATFORM ? "⌘" : "Ctrl+";
export const ALT_KEY = IS_MAC_PLATFORM ? "⌥" : "Alt+";
export const QUICK_CHAT_SHORTCUT = `${ALT_KEY}C`;
