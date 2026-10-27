// A Channel is the contract the rest of the plugin talks to when it wants to
// reach the person. Today there is exactly one implementation (the iLink
// transport), and it is tempting to keep calling `transport.send(...)` from
// every send path — but every one of those call sites then knows about
// contextToken, sendMedia, setTyping, and which of them are optional. That
// knowledge is what makes a second transport (an official API, a webhook) a
// rewrite instead of an adapter.
//
// The contract is deliberately small and shape-compatible with what the
// transport already does, so wrapping costs nothing at runtime:
//
//   channel.capabilities            { text, media, typing, voice, stickers }
//   channel.accountId               the account this channel speaks for
//   channel.sendText({ conversationId, text, contextToken })
//   channel.sendMedia({ conversationId, filePath, text, contextToken, cdnBaseUrl })
//   channel.setTyping(active, conversationId)
//
// Anything a channel cannot do is announced through `capabilities` instead of
// being discovered by a thrown error in the middle of a reply.

const DEFAULT_CAPABILITIES = Object.freeze({
  text: true,
  media: true,
  typing: true,
  // The vendor defines a VOICE item but the server accepts and silently drops
  // it (measured twice, see docs/progress.md), so no channel advertises voice
  // until that changes.
  voice: false,
  // Weixin has no sticker item type at all: a "sticker" is an image upload.
  stickers: false,
});

/**
 * Wrap a transport in the channel contract.
 *
 * `capabilities` is read from the transport when it advertises one, so a future
 * transport can declare its own; otherwise the defaults above apply.
 */
export function createChannel(transport) {
  if (transport === undefined || transport === null) {
    throw new Error('createChannel needs a transport');
  }
  const capabilities = { ...DEFAULT_CAPABILITIES, ...(transport.capabilities ?? {}) };
  return {
    accountId: transport.accountId,
    capabilities,
    transport,
    sendText: ({ conversationId, text, contextToken }) =>
      transport.send({ conversationId, type: 'text', text, contextToken }),
    sendMedia: ({ conversationId, filePath, text = '', contextToken, cdnBaseUrl }) =>
      transport.sendMedia({ conversationId, filePath, text, contextToken, cdnBaseUrl }),
    setTyping: (active, conversationId) => transport.setTyping(active, conversationId),
  };
}

const CACHE = new WeakMap();

/**
 * The channel for a transport, created once and reused.
 *
 * Send paths run on every message and on every timer tick; building a wrapper
 * each time would be harmless but pointless, and the identity is useful when a
 * test wants to prove two paths used the same channel.
 */
export function channelFor(transport) {
  if (transport === undefined || transport === null) return undefined;
  let channel = CACHE.get(transport);
  if (channel === undefined) {
    channel = createChannel(transport);
    CACHE.set(transport, channel);
  }
  return channel;
}

/** A channel can send at all only if it can carry text. */
export function canSendText(channel) {
  return channel !== undefined && channel.capabilities?.text === true;
}
