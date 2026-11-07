/**
 * An app's name as the lite view's `host` gives it (`/lite?host=siyuan`): lowercase letters, digits and dashes, 32 at
 * most. A message sent from that view carries it, and an extension's widget may name it (chat host `message_host`).
 */
export const MESSAGE_HOST_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
