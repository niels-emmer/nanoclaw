import {
  createClient,
  ClientEvent,
  RoomEvent,
  RoomMemberEvent,
  MsgType,
  type MatrixClient,
  type MatrixEvent,
  type Room,
  type RoomMember,
} from 'matrix-js-sdk';
import { escapeXml } from '../router.js';

export function markdownToHtml(text: string): string {
  const placeholders = new Map<string, string>();
  let counter = 0;

  const protect = (html: string): string => {
    const key = `\x00P${counter++}\x00`;
    placeholders.set(key, html);
    return key;
  };

  let html = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const escaped = escapeXml(code.replace(/\n$/, ''));
    return protect(
      lang
        ? `<pre><code class="language-${lang}">${escaped}</code></pre>`
        : `<pre><code>${escaped}</code></pre>`,
    );
  });

  html = html.replace(/`([^`\n]+)`/g, (_, code) =>
    protect(`<code>${escapeXml(code)}</code>`),
  );

  html = escapeXml(html);

  html = html.replace(
    /^(#{1,6})\s+(.+)$/gm,
    (_, hashes: string, content: string) =>
      `<h${hashes.length}>${content}</h${hashes.length}>`,
  );

  // ** must match before * so double-asterisks aren't consumed by the single-asterisk rule
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<strong>$1</strong>');
  html = html.replace(/_(.+?)_/g, '<em>$1</em>');
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  html = html.replace(/\n/g, '<br>\n');

  for (const [key, value] of placeholders) {
    html = html.replace(key, value);
  }

  return html;
}

import { transcribeBuffer } from '../transcription.js';
import { type Channel } from '../types.js';
import { registerChannel, type ChannelOpts } from './registry.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';

const JID_PREFIX = 'mx:';
const MAX_MESSAGE_LEN = 32000;
const TYPING_TIMEOUT_MS = 30000;

function toJid(roomId: string): string {
  return `${JID_PREFIX}${roomId}`;
}

function fromJid(jid: string): string {
  return jid.slice(JID_PREFIX.length);
}

function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    const breakAt = remaining.lastIndexOf('\n', maxLen);
    const splitAt = breakAt > 0 ? breakAt + 1 : maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

class MatrixChannel implements Channel {
  readonly name = 'matrix';
  private connected = false;
  private readonly botUserId: string;
  private readonly onMessage: ChannelOpts['onMessage'];
  private readonly onChatMetadata: ChannelOpts['onChatMetadata'];

  constructor(
    private readonly client: MatrixClient,
    botUserId: string,
    opts: ChannelOpts,
  ) {
    this.botUserId = botUserId;
    this.onMessage = opts.onMessage;
    this.onChatMetadata = opts.onChatMetadata;
  }

  async connect(): Promise<void> {
    this.client.on(ClientEvent.Sync, (state: string) => {
      if (state === 'PREPARED') {
        this.connected = true;
        logger.info('Matrix channel connected');
        // Accept any pending invites that arrived before or during initial sync
        for (const room of this.client.getRooms()) {
          if (room.getMyMembership() === 'invite') {
            this.client.joinRoom(room.roomId).then(
              () =>
                logger.info(
                  { roomId: room.roomId },
                  'Accepted pending Matrix invite',
                ),
              (err: unknown) =>
                logger.warn(
                  { roomId: room.roomId, err },
                  'Failed to accept Matrix invite',
                ),
            );
          }
        }
      } else if (state === 'ERROR' || state === 'STOPPED') {
        this.connected = false;
        logger.warn({ state }, 'Matrix sync state changed');
      }
    });

    // Auto-accept future room invites
    this.client.on(
      RoomMemberEvent.Membership,
      (event: MatrixEvent, member: RoomMember) => {
        if (
          member.userId === this.botUserId &&
          member.membership === 'invite'
        ) {
          this.client.joinRoom(member.roomId).then(
            () =>
              logger.info(
                { roomId: member.roomId },
                'Accepted Matrix room invite',
              ),
            (err: unknown) =>
              logger.warn(
                { roomId: member.roomId, err },
                'Failed to accept Matrix invite',
              ),
          );
        }
      },
    );

    this.client.on(
      RoomEvent.Timeline,
      (
        event: MatrixEvent,
        room: Room | undefined,
        toStartOfTimeline: boolean | undefined,
      ) => {
        if (toStartOfTimeline) return;
        if (event.getType() !== 'm.room.message') return;

        const content = event.getContent() as {
          msgtype?: string;
          body?: string;
          url?: string;
          info?: { mimetype?: string };
        };
        if (
          content.msgtype !== MsgType.Text &&
          content.msgtype !== MsgType.Audio
        )
          return;

        const sender = event.getSender();
        if (!sender || sender === this.botUserId) return;

        const roomId = event.getRoomId();
        if (!roomId) return;

        const jid = toJid(roomId);
        const timestamp = new Date(event.getTs()).toISOString();
        const senderName = room?.getMember(sender)?.name ?? sender;

        this.onChatMetadata(jid, timestamp, room?.name, 'matrix', true);

        if (content.msgtype === MsgType.Audio) {
          void this.handleAudioMessage(
            event.getId() ?? `matrix_${Date.now()}`,
            jid,
            sender,
            senderName,
            timestamp,
            content.url,
            content.info?.mimetype,
          );
          return;
        }

        if (!content.body) return;
        this.onMessage(jid, {
          id: event.getId() ?? `matrix_${Date.now()}`,
          chat_jid: jid,
          sender,
          sender_name: senderName,
          content: content.body,
          timestamp,
          is_from_me: false,
          is_bot_message: false,
        });
      },
    );

    await this.client.startClient({ initialSyncLimit: 0 });
    logger.info('Matrix client started');
  }

  private async handleAudioMessage(
    id: string,
    jid: string,
    sender: string,
    senderName: string,
    timestamp: string,
    mxcUrl: string | undefined,
    mimetype?: string,
  ): Promise<void> {
    let content: string;
    const httpUrl = mxcUrl ? this.client.mxcUrlToHttp(mxcUrl) : null;
    if (!httpUrl) {
      content = '[Voice Message - transcription unavailable]';
    } else {
      try {
        const response = await fetch(httpUrl);
        if (!response.ok) {
          logger.error({ status: response.status, url: httpUrl }, 'Failed to download Matrix audio');
          content = '[Voice Message - download failed]';
        } else {
          const buffer = Buffer.from(await response.arrayBuffer());
          const detectedMime = response.headers.get('content-type') ?? mimetype;
          const transcript = await transcribeBuffer(buffer, detectedMime ?? undefined);
          content = `[Voice: ${transcript}]`;
        }
      } catch (err) {
        logger.error({ err }, 'Matrix voice transcription error');
        content = '[Voice Message - transcription failed]';
      }
    }
    this.onMessage(jid, {
      id,
      chat_jid: jid,
      sender,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
      is_bot_message: false,
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const roomId = fromJid(jid);
    const chunks = splitMessage(text, MAX_MESSAGE_LEN);
    for (const chunk of chunks) {
      await this.client.sendHtmlMessage(roomId, chunk, markdownToHtml(chunk));
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(JID_PREFIX);
  }

  async disconnect(): Promise<void> {
    this.client.stopClient();
    this.connected = false;
    logger.info('Matrix channel disconnected');
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    const roomId = fromJid(jid);
    await this.client.sendTyping(
      roomId,
      isTyping,
      isTyping ? TYPING_TIMEOUT_MS : 0,
    );
  }
}

registerChannel('matrix', (opts: ChannelOpts) => {
  const env = readEnvFile([
    'MATRIX_HOMESERVER_URL',
    'MATRIX_USER_ID',
    'MATRIX_ACCESS_TOKEN',
  ]);

  const { MATRIX_HOMESERVER_URL, MATRIX_USER_ID, MATRIX_ACCESS_TOKEN } = env;
  if (!MATRIX_HOMESERVER_URL || !MATRIX_USER_ID || !MATRIX_ACCESS_TOKEN) {
    return null;
  }

  const client = createClient({
    baseUrl: MATRIX_HOMESERVER_URL,
    userId: MATRIX_USER_ID,
    accessToken: MATRIX_ACCESS_TOKEN,
  });

  return new MatrixChannel(client, MATRIX_USER_ID, opts);
});
