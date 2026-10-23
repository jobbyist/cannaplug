/** Removes every member's chat history and session id from this tab (used on sign-out). */
export function clearChatStorage(storage: Storage = window.sessionStorage) {
  try {
    for (let i = storage.length - 1; i >= 0; i--) {
      const k = storage.key(i);
      if (k && (k.startsWith("cannaplug.chat.") || k === "cannaplug.chat.v1"))
        storage.removeItem(k);
    }
  } catch {
    /* storage unavailable */
  }
}
